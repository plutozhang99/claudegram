import 'dart:async';

import '../models/session.dart';
import '../models/statusline.dart';
import '../services/harbor_api_client.dart';
import '../services/harbor_live_service.dart';

/// Repository backing the live session list + detail views.
class SessionRepository {
  final HarborApiClient api;
  final HarborLiveService live;

  /// Injectable clock for deterministic [SessionEnded] fallback timestamps
  /// in tests. Defaults to [DateTime.now].
  final DateTime Function() now;

  SessionRepository({
    required this.api,
    required this.live,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;

  Future<List<Session>> fetchList({String? status}) async {
    final res = await api.listSessions(status: status);
    return res.sessions;
  }

  Future<Session> fetchOne(String id) async {
    final res = await api.getSession(id);
    return res.session;
  }

  /// Live list stream: initial REST load merged with WS mutations.
  ///
  /// Mutations apply immutably — the cached list is replaced on every
  /// change. Re-emits a new sorted list on each mutation, sorted by
  /// `latestStatuslineAt` desc (nulls last), then `startedAt` desc,
  /// then `sessionId` desc for stable ordering on ties.
  ///
  /// On every reconnect AFTER the initial load, the cache is refreshed
  /// via REST — the server replays `session.created` on reconnect but
  /// NOT `session.ended`, so without refetch the cache could retain
  /// sessions that ended during the disconnect window.
  Stream<List<Session>> watchList({String? status}) async* {
    final controller = StreamController<List<Session>>();
    List<Session> cache = <Session>[];
    var closed = false;
    var initialLoadDone = false;
    var refetchInFlight = false;

    StreamSubscription<HarborEvent>? liveSub;

    void emit() {
      if (closed) return;
      controller.add(_sorted(cache));
    }

    Future<void> refetch() async {
      if (closed || refetchInFlight) return;
      refetchInFlight = true;
      try {
        final next = await fetchList(status: status);
        if (closed) return;
        cache = next;
        emit();
      } catch (_) {
        // Keep the stale cache — the next reconnect will retry.
      } finally {
        refetchInFlight = false;
      }
    }

    Future<void> init() async {
      try {
        cache = await fetchList(status: status);
      } catch (e, st) {
        if (!closed) controller.addError(e, st);
        return;
      }
      // Consumer may have cancelled during the await above. Bail out
      // BEFORE we subscribe to live events, otherwise liveSub would
      // leak past cancellation (onCancel already ran with liveSub null).
      if (closed) return;
      initialLoadDone = true;
      emit();
      liveSub = live.events.listen((ev) {
        if (ev is ConnectionStateChanged &&
            ev.state == HarborConnectionState.connected &&
            initialLoadDone) {
          // Debounced inside refetch() itself.
          unawaited(refetch());
          return;
        }
        final next = _applyEvent(cache, ev, status);
        if (!identical(next, cache)) {
          cache = next;
          emit();
        }
      });
    }

    controller.onListen = init;
    controller.onCancel = () async {
      closed = true;
      await liveSub?.cancel();
      liveSub = null;
    };

    yield* controller.stream;
  }

  static bool _statusMatches(String? filter, String sessionStatus) {
    if (filter == null || filter == 'all') return true;
    return filter == sessionStatus;
  }

  /// Reducer: given a cached list and an event, return a new list
  /// (or the same reference when the event is irrelevant). Never mutates.
  List<Session> _applyEvent(
    List<Session> cache,
    HarborEvent ev,
    String? statusFilter,
  ) {
    if (ev is SessionCreated) {
      if (!_statusMatches(statusFilter, ev.session.status)) return cache;
      final idx = _indexOf(cache, ev.session.sessionId);
      if (idx == -1) {
        return <Session>[ev.session, ...cache];
      }
      return _replaceAt(cache, idx, ev.session);
    }
    if (ev is SessionUpdated) {
      final idx = _indexOf(cache, ev.session.sessionId);
      if (idx == -1) {
        if (_statusMatches(statusFilter, ev.session.status)) {
          return <Session>[ev.session, ...cache];
        }
        return cache;
      }
      if (!_statusMatches(statusFilter, ev.session.status)) {
        return _removeAt(cache, idx);
      }
      return _replaceAt(cache, idx, ev.session);
    }
    if (ev is SessionEnded) {
      final idx = _indexOf(cache, ev.sessionId);
      if (idx == -1) return cache;
      final patched = cache[idx].copyWith(
        status: 'ended',
        endedAt: () => cache[idx].endedAt ?? now().millisecondsSinceEpoch,
      );
      if (!_statusMatches(statusFilter, patched.status)) {
        return _removeAt(cache, idx);
      }
      return _replaceAt(cache, idx, patched);
    }
    if (ev is StatuslineUpdated) {
      final idx = _indexOf(cache, ev.sessionId);
      if (idx == -1) return cache;
      final patched = _applyStatusline(cache[idx], ev.statusline);
      return _replaceAt(cache, idx, patched);
    }
    return cache;
  }

  static Session _applyStatusline(Session current, Statusline s) {
    return current.copyWith(
      latestModel: () => s.latestModel,
      latestModelDisplay: () => s.latestModelDisplay,
      latestVersion: () => s.latestVersion,
      latestPermissionMode: () => s.latestPermissionMode,
      latestCtxPct: () => s.latestCtxPct,
      latestCtxWindowSize: () => s.latestCtxWindowSize,
      latestLimitsJson: () => s.latestLimitsJson,
      latestCostUsd: () => s.latestCostUsd,
      latestStatuslineAt: () => s.latestStatuslineAt,
    );
  }

  static int _indexOf(List<Session> list, String sessionId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].sessionId == sessionId) return i;
    }
    return -1;
  }

  static List<Session> _replaceAt(List<Session> list, int idx, Session s) {
    final out = List<Session>.from(list);
    out[idx] = s;
    return out;
  }

  static List<Session> _removeAt(List<Session> list, int idx) {
    final out = List<Session>.from(list);
    out.removeAt(idx);
    return out;
  }

  /// Sort sessions by latestStatuslineAt desc (nulls last), then startedAt
  /// desc, then sessionId desc for stable ordering on ties.
  static List<Session> _sorted(List<Session> list) {
    final out = List<Session>.from(list);
    out.sort((a, b) {
      final aNull = a.latestStatuslineAt == null;
      final bNull = b.latestStatuslineAt == null;
      if (aNull != bNull) return aNull ? 1 : -1;
      if (!aNull) {
        final c = b.latestStatuslineAt!.compareTo(a.latestStatuslineAt!);
        if (c != 0) return c;
      }
      final sc = b.startedAt.compareTo(a.startedAt);
      if (sc != 0) return sc;
      return b.sessionId.compareTo(a.sessionId);
    });
    return out;
  }
}
