import 'dart:async';

import 'package:claude_harbor_frontend/models/session.dart';
import 'package:claude_harbor_frontend/models/statusline.dart';
import 'package:claude_harbor_frontend/repositories/session_repository.dart';
import 'package:claude_harbor_frontend/services/harbor_api_client.dart';
import 'package:claude_harbor_frontend/services/harbor_live_service.dart';
import 'package:flutter_test/flutter_test.dart';

/// Minimal fake HarborApiClient that satisfies SessionRepository's usage.
class _FakeApi implements HarborApiClient {
  _FakeApi(this.initial, {this.delay = Duration.zero, this.extraPages});
  List<Session> initial;
  final Duration delay;

  /// Optional follow-up responses served on subsequent [listSessions] calls
  /// (used to exercise reconnect refetch).
  final List<List<Session>>? extraPages;
  int _calls = 0;

  @override
  Uri get baseUri => Uri.parse('http://fake');

  @override
  Duration get timeout => const Duration(seconds: 10);

  @override
  Future<SessionListResponse> listSessions({
    String? status,
    int? limit,
    int? offset,
  }) async {
    if (delay > Duration.zero) {
      await Future<void>.delayed(delay);
    }
    final callIdx = _calls++;
    final body = (extraPages != null && callIdx > 0 &&
            callIdx - 1 < extraPages!.length)
        ? extraPages![callIdx - 1]
        : initial;
    return SessionListResponse(sessions: body, total: body.length);
  }

  @override
  Future<SessionDetailResponse> getSession(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<MessagePage> listMessages(String s, {int? before, int? limit}) =>
      throw UnimplementedError();

  @override
  Future<void> postChannelReply({
    required String channelToken,
    required String content,
    Map<String, String>? meta,
  }) async {}

  @override
  Future<String> adminFetchChannelToken(
    String sessionId, {
    String? adminToken,
  }) async =>
      throw UnimplementedError();

  @override
  void close() {}
}

/// Fake live service — exposes an injectable controller so tests can push
/// arbitrary HarborEvents without spinning up a WS.
class _FakeLive implements HarborLiveService {
  _FakeLive();
  final StreamController<HarborEvent> controller =
      StreamController<HarborEvent>.broadcast();

  @override
  Stream<HarborEvent> get events => controller.stream;

  @override
  Future<void> start() async {}

  @override
  Future<void> stop() async {
    await controller.close();
  }

  @override
  Uri get wsUri => Uri.parse('ws://fake/subscribe');

  @override
  Duration get reconnectDelay => Duration.zero;

  @override
  Duration get maxReconnectDelay => Duration.zero;

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Session _session({
  required String id,
  int startedAt = 0,
  int? statuslineAt,
  String status = 'active',
  String? model,
}) {
  return Session.fromJson(<String, dynamic>{
    'session_id': id,
    'started_at': startedAt,
    'latest_statusline_at': statuslineAt,
    'latest_model': model,
    'status': status,
  });
}

void main() {
  group('SessionRepository.watchList', () {
    test('initial REST load emits sorted list', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 100),
        _session(id: 'b', startedAt: 2, statuslineAt: 200),
        _session(id: 'c', startedAt: 3, statuslineAt: null),
      ]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);
      final first = await repo.watchList().first;
      expect(first.map((s) => s.sessionId).toList(), <String>['b', 'a', 'c']);
      await live.stop();
    });

    test('stable ordering on ties via session_id desc', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 5, statuslineAt: 100),
        _session(id: 'b', startedAt: 5, statuslineAt: 100),
      ]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);
      final first = await repo.watchList().first;
      expect(first.map((s) => s.sessionId).toList(), <String>['b', 'a']);
      await live.stop();
    });

    test('SessionCreated prepends new session', () async {
      final api = _FakeApi(<Session>[]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);

      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      live.controller.add(
        SessionCreated(_session(id: 'new', startedAt: 10, statuslineAt: 50)),
      );
      await Future<void>.delayed(Duration.zero);
      expect(emissions.last.map((s) => s.sessionId).toList(), <String>['new']);
      await sub.cancel();
      await live.stop();
    });

    test('SessionUpdated replaces existing entry', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10, model: 'old'),
      ]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);

      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      live.controller.add(
        SessionUpdated(_session(id: 'a', startedAt: 1, statuslineAt: 10, model: 'new')),
      );
      await Future<void>.delayed(Duration.zero);
      expect(emissions.last.single.latestModel, 'new');
      await sub.cancel();
      await live.stop();
    });

    test('SessionEnded patches status and keeps id in cache', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10),
      ]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);
      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      live.controller.add(const SessionEnded('a'));
      await Future<void>.delayed(Duration.zero);
      final latest = emissions.last.single;
      expect(latest.status, 'ended');
      expect(latest.endedAt, isNotNull);
      await sub.cancel();
      await live.stop();
    });

    test('StatuslineUpdated patches only latest_* fields', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10, model: 'old'),
      ]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);
      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      final statusline = Statusline.fromJson(
        sessionId: 'a',
        statusline: const <String, dynamic>{
          'latest_model': 'new',
          'latest_model_display': 'New Model',
          'latest_ctx_pct': 55.5,
          'latest_ctx_window_size': 200000,
          'latest_limits_json': null,
          'latest_cost_usd': 0.1,
          'latest_version': '2.0',
          'latest_permission_mode': 'default',
          'latest_statusline_at': 999,
        },
      );
      live.controller
          .add(StatuslineUpdated(sessionId: 'a', statusline: statusline));
      await Future<void>.delayed(Duration.zero);
      final latest = emissions.last.single;
      expect(latest.latestModel, 'new');
      expect(latest.latestCtxPct, 55.5);
      expect(latest.latestStatuslineAt, 999);
      // Identity fields preserved.
      expect(latest.sessionId, 'a');
      expect(latest.status, 'active');
      await sub.cancel();
      await live.stop();
    });

    test('cancel during fetchList does not leak live events', () async {
      // Slow fake API so we can cancel the subscription mid-await.
      final api = _FakeApi(
        <Session>[_session(id: 'a', startedAt: 1, statuslineAt: 10)],
        delay: const Duration(milliseconds: 30),
      );
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);

      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      // Cancel before the initial fetch resolves.
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await sub.cancel();
      // Give the pending fetchList time to complete post-cancel.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      // Now push a live event; if liveSub leaked, this would blow up or emit.
      live.controller.add(
        SessionCreated(_session(id: 'b', startedAt: 2, statuslineAt: 20)),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(emissions, isEmpty);
      await live.stop();
    });

    test('SessionEnded fallback endedAt uses injected clock', () async {
      final api = _FakeApi(<Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10),
      ]);
      final live = _FakeLive();
      final fixedMs = 1714000000000;
      final repo = SessionRepository(
        api: api,
        live: live,
        now: () => DateTime.fromMillisecondsSinceEpoch(fixedMs),
      );
      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      live.controller.add(const SessionEnded('a'));
      await Future<void>.delayed(Duration.zero);
      expect(emissions.last.single.endedAt, fixedMs);
      await sub.cancel();
      await live.stop();
    });

    test('refetches on reconnect after initial load', () async {
      final initial = <Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10),
        _session(id: 'b', startedAt: 2, statuslineAt: 20),
      ];
      // After reconnect, server returns only 'a' (b ended during disconnect).
      final refetched = <Session>[
        _session(id: 'a', startedAt: 1, statuslineAt: 10),
      ];
      final api = _FakeApi(initial, extraPages: <List<Session>>[refetched]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);

      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      expect(emissions.last.map((s) => s.sessionId).toList(),
          <String>['b', 'a']);
      // Simulate reconnect transition.
      live.controller.add(
        const ConnectionStateChanged(HarborConnectionState.connected),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(emissions.last.map((s) => s.sessionId).toList(), <String>['a']);
      await sub.cancel();
      await live.stop();
    });

    test('ignores events for sessions not in cache (except create)', () async {
      final api = _FakeApi(<Session>[]);
      final live = _FakeLive();
      final repo = SessionRepository(api: api, live: live);
      final emissions = <List<Session>>[];
      final sub = repo.watchList().listen(emissions.add);
      await Future<void>.delayed(Duration.zero);
      final emissionsBefore = emissions.length;
      live.controller.add(const SessionEnded('missing'));
      await Future<void>.delayed(Duration.zero);
      expect(emissions.length, emissionsBefore); // no new emit
      await sub.cancel();
      await live.stop();
    });
  });
}
