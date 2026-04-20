import 'dart:async';

import '../models/message.dart';
import '../services/harbor_api_client.dart';
import '../services/harbor_live_service.dart';

/// Default REST page size for chat backfill.
const int kDefaultMessagePageLimit = 100;

/// Repository for chat history + live inbound/outbound message feed.
///
/// Two stream shapes are exposed:
///
///  * [watchMessages] — a chronological (ascending id) list snapshot for a
///    single session. Emits on REST backfill, on live `MessageCreated`
///    events, and on older-page appends from [loadOlder]. Intended for the
///    P2.4 chat pane.
///  * [watchInbox] — the raw per-event stream of freshly-created messages
///    for a session. Intended for narrow listeners (tests, badges, etc).
class MessageRepository {
  final HarborApiClient api;
  final HarborLiveService live;

  // Per-session in-memory feed cache. OK for P2.4 — bounded to the sessions
  // the user actually viewed during this app lifetime. No eviction yet.
  final Map<String, _MessageFeed> _feeds = <String, _MessageFeed>{};

  MessageRepository({required this.api, required this.live});

  Future<MessagePage> fetchPage(
    String sessionId, {
    int? before,
    int? limit,
  }) {
    return api.listMessages(sessionId, before: before, limit: limit);
  }

  /// Stream of newly-created messages for [sessionId]. Raw per-event form —
  /// use [watchMessages] for a chat-pane-style chronological list.
  Stream<Message> watchInbox(String sessionId) {
    return live.events
        .where((e) => e is MessageCreated && e.sessionId == sessionId)
        .map((e) => (e as MessageCreated).message);
  }

  /// Chronologically-sorted message list for [sessionId].
  ///
  /// Behavior:
  ///  * First subscription fetches the first REST page (most recent first,
  ///    descending by id) and emits it reversed to ascending order.
  ///  * Subsequent `MessageCreated` events for the same session are
  ///    appended, deduped by id, and re-sorted ascending.
  ///  * Multiple subscribers to the same session share the same cache.
  Stream<List<Message>> watchMessages(String sessionId) {
    final feed = _feeds.putIfAbsent(
      sessionId,
      () => _MessageFeed(sessionId: sessionId, api: api, live: live),
    );
    return feed.stream;
  }

  /// Fetch an older page of messages for [sessionId] anchored at [before].
  /// Appends loaded messages to the in-memory feed (if one exists for the
  /// session) and emits an updated list.
  ///
  /// Returns the page messages (ascending id) and `nextBefore` cursor.
  Future<({List<Message> messages, int? nextBefore})> loadOlder(
    String sessionId, {
    required int before,
    int limit = kDefaultMessagePageLimit,
  }) async {
    final page = await api.listMessages(
      sessionId,
      before: before,
      limit: limit,
    );
    final ascending = page.messages.reversed.toList(growable: false);
    final feed = _feeds[sessionId];
    if (feed != null) {
      feed.mergeOlder(ascending);
    }
    return (messages: ascending, nextBefore: page.nextBefore);
  }

  /// Dispose the feed for [sessionId], if any. Exposed so tests + future
  /// lifecycle hooks can release cached state.
  Future<void> disposeSession(String sessionId) async {
    final feed = _feeds.remove(sessionId);
    await feed?.dispose();
  }
}

/// Private per-session message feed. Owns its broadcast StreamController,
/// a sorted+deduped message cache, and the subscription to live events.
class _MessageFeed {
  _MessageFeed({
    required this.sessionId,
    required this.api,
    required this.live,
  }) {
    _controller = StreamController<List<Message>>.broadcast(
      onListen: _onListen,
      onCancel: _onCancel,
    );
  }

  final String sessionId;
  final HarborApiClient api;
  final HarborLiveService live;

  late final StreamController<List<Message>> _controller;
  StreamSubscription<HarborEvent>? _liveSub;
  List<Message> _cache = const <Message>[];
  bool _initialLoadStarted = false;
  bool _closed = false;

  Stream<List<Message>> get stream => _controller.stream;

  void _onListen() {
    if (_initialLoadStarted) {
      // Replay the current cache for a late subscriber so they see
      // something immediately instead of waiting for the next event.
      _controller.add(_cache);
      return;
    }
    _initialLoadStarted = true;
    _subscribeLive();
    unawaited(_primeFromApi());
  }

  void _subscribeLive() {
    _liveSub ??= live.events.listen((ev) {
      if (_closed) return;
      if (ev is MessageCreated && ev.sessionId == sessionId) {
        _appendOne(ev.message);
      }
    });
  }

  Future<void> _primeFromApi() async {
    try {
      final page = await api.listMessages(
        sessionId,
        limit: kDefaultMessagePageLimit,
      );
      if (_closed) return;
      // Server returns descending by id; reverse for chronological display.
      final ascending = page.messages.reversed.toList(growable: false);
      _cache = _mergeSorted(_cache, ascending);
      _controller.add(_cache);
    } catch (e, st) {
      if (!_closed && _controller.hasListener) {
        _controller.addError(e, st);
      }
    }
  }

  void _appendOne(Message m) {
    _cache = _mergeSorted(_cache, <Message>[m]);
    if (!_closed) _controller.add(_cache);
  }

  void mergeOlder(List<Message> older) {
    if (_closed) return;
    _cache = _mergeSorted(_cache, older);
    _controller.add(_cache);
  }

  Future<void> _onCancel() async {
    // Keep the cache alive across resubscribes — many widgets will cancel
    // + resubscribe on route transitions, and dropping the cache would
    // force a REST refetch every time. Actual teardown happens in
    // [dispose] when the repository wants to release the session.
  }

  Future<void> dispose() async {
    _closed = true;
    await _liveSub?.cancel();
    _liveSub = null;
    if (!_controller.isClosed) {
      await _controller.close();
    }
  }

  // Merge two message lists, dedup by id, emit ascending-by-id copy.
  static List<Message> _mergeSorted(List<Message> a, List<Message> b) {
    if (a.isEmpty && b.isEmpty) return const <Message>[];
    final Map<int, Message> byId = <int, Message>{};
    for (final Message m in a) {
      byId[m.id] = m;
    }
    for (final Message m in b) {
      byId[m.id] = m;
    }
    final merged = byId.values.toList(growable: false);
    merged.sort((x, y) => x.id.compareTo(y.id));
    return List<Message>.unmodifiable(merged);
  }
}
