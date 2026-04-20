import 'dart:async';

import 'package:claude_harbor_frontend/models/message.dart';
import 'package:claude_harbor_frontend/repositories/message_repository.dart';
import 'package:claude_harbor_frontend/services/harbor_api_client.dart';
import 'package:claude_harbor_frontend/services/harbor_live_service.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApi implements HarborApiClient {
  _FakeApi(this.page);
  final MessagePage page;
  final List<List<Object?>> calls = <List<Object?>>[];
  // Override page for specific `before` cursors (loadOlder tests).
  final Map<int, MessagePage> olderPages = <int, MessagePage>{};

  @override
  Uri get baseUri => Uri.parse('http://fake');

  @override
  Duration get timeout => const Duration(seconds: 10);

  @override
  Future<MessagePage> listMessages(String s, {int? before, int? limit}) async {
    calls.add(<Object?>[s, before, limit]);
    if (before != null && olderPages.containsKey(before)) {
      return olderPages[before]!;
    }
    return page;
  }

  @override
  Future<SessionListResponse> listSessions({
    String? status,
    int? limit,
    int? offset,
  }) =>
      throw UnimplementedError();

  @override
  Future<SessionDetailResponse> getSession(String sessionId) =>
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
      'tok-$sessionId';

  @override
  void close() {}
}

class _FakeLive implements HarborLiveService {
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

Message _message({
  int id = 1,
  String sessionId = 'sess-1',
  String content = 'hi',
  MessageDirection direction = MessageDirection.inbound,
}) {
  return Message(
    id: id,
    sessionId: sessionId,
    direction: direction,
    content: content,
    metaJson: null,
    createdAt: 1700000000000,
  );
}

void main() {
  group('MessageRepository.watchInbox', () {
    test('filters by sessionId and drops other-session MessageCreated',
        () async {
      final api = _FakeApi(
        const MessagePage(messages: <Message>[], nextBefore: null),
      );
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final received = <Message>[];
      final sub = repo.watchInbox('sess-1').listen(received.add);
      await Future<void>.delayed(Duration.zero);

      // Different session — must be dropped.
      live.controller.add(MessageCreated(
        sessionId: 'sess-2',
        message: _message(id: 10, sessionId: 'sess-2'),
      ));
      // Target session — must pass through.
      live.controller.add(MessageCreated(
        sessionId: 'sess-1',
        message: _message(id: 11, sessionId: 'sess-1'),
      ));
      await Future<void>.delayed(Duration.zero);

      expect(received.map((m) => m.id).toList(), <int>[11]);

      await sub.cancel();
      await live.stop();
    });

    test('drops non-MessageCreated events', () async {
      final api = _FakeApi(
        const MessagePage(messages: <Message>[], nextBefore: null),
      );
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final received = <Message>[];
      final sub = repo.watchInbox('sess-1').listen(received.add);
      await Future<void>.delayed(Duration.zero);

      live.controller.add(const SessionEnded('sess-1'));
      live.controller.add(const SubscribedAck());
      live.controller.add(
        const ConnectionStateChanged(HarborConnectionState.connected),
      );
      await Future<void>.delayed(Duration.zero);

      expect(received, isEmpty);

      await sub.cancel();
      await live.stop();
    });
  });

  group('MessageRepository.fetchPage', () {
    test('forwards args and returns the API page', () async {
      final expected = MessagePage(
        messages: <Message>[_message(id: 7)],
        nextBefore: 7,
      );
      final api = _FakeApi(expected);
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final page = await repo.fetchPage('sess-1', before: 100, limit: 25);

      expect(api.calls, hasLength(1));
      expect(api.calls.single, <Object?>['sess-1', 100, 25]);
      expect(page, same(expected));
      expect(page.messages, hasLength(1));
      expect(page.nextBefore, 7);

      await live.stop();
    });
  });

  group('MessageRepository.watchMessages', () {
    test('emits initial REST-backed list in ascending order', () async {
      // Server returns descending by id — repository must reverse.
      final api = _FakeApi(MessagePage(
        messages: <Message>[
          _message(id: 3, content: 'third'),
          _message(id: 2, content: 'second'),
          _message(id: 1, content: 'first'),
        ],
        nextBefore: null,
      ));
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final List<List<Message>> emissions = <List<Message>>[];
      final sub = repo.watchMessages('sess-1').listen(emissions.add);
      // Let the microtask + REST completion run.
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(emissions, isNotEmpty);
      final List<Message> latest = emissions.last;
      expect(latest.map((m) => m.id).toList(), <int>[1, 2, 3]);

      await sub.cancel();
      await live.stop();
      await repo.disposeSession('sess-1');
    });

    test('appends new MessageCreated events in order, deduped by id',
        () async {
      final api = _FakeApi(MessagePage(
        messages: <Message>[_message(id: 1)],
        nextBefore: null,
      ));
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final List<List<Message>> emissions = <List<Message>>[];
      final sub = repo.watchMessages('sess-1').listen(emissions.add);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      live.controller.add(MessageCreated(
        sessionId: 'sess-1',
        message: _message(id: 2, content: 'b'),
      ));
      live.controller.add(MessageCreated(
        sessionId: 'sess-1',
        message: _message(id: 3, content: 'c'),
      ));
      // Duplicate id — must be deduped.
      live.controller.add(MessageCreated(
        sessionId: 'sess-1',
        message: _message(id: 2, content: 'b-updated'),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final List<Message> latest = emissions.last;
      expect(latest.map((m) => m.id).toList(), <int>[1, 2, 3]);

      await sub.cancel();
      await live.stop();
      await repo.disposeSession('sess-1');
    });

    test('drops events from other sessions', () async {
      final api = _FakeApi(const MessagePage(
        messages: <Message>[],
        nextBefore: null,
      ));
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final List<List<Message>> emissions = <List<Message>>[];
      final sub = repo.watchMessages('sess-1').listen(emissions.add);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      live.controller.add(MessageCreated(
        sessionId: 'sess-2',
        message: _message(id: 99, sessionId: 'sess-2'),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Only the initial empty list emission — no event appends.
      expect(emissions.last, isEmpty);

      await sub.cancel();
      await live.stop();
      await repo.disposeSession('sess-1');
    });
  });

  group('MessageRepository.loadOlder', () {
    test('returns older page in ascending order with next_before', () async {
      final api = _FakeApi(const MessagePage(
        messages: <Message>[],
        nextBefore: null,
      ));
      api.olderPages[10] = MessagePage(
        messages: <Message>[
          _message(id: 9),
          _message(id: 8),
          _message(id: 7),
        ],
        nextBefore: 7,
      );
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      final result = await repo.loadOlder('sess-1', before: 10, limit: 50);

      expect(result.messages.map((m) => m.id).toList(), <int>[7, 8, 9]);
      expect(result.nextBefore, 7);

      await live.stop();
    });

    test('forwards before + limit to the API', () async {
      final api = _FakeApi(const MessagePage(
        messages: <Message>[],
        nextBefore: null,
      ));
      api.olderPages[42] = const MessagePage(
        messages: <Message>[],
        nextBefore: null,
      );
      final live = _FakeLive();
      final repo = MessageRepository(api: api, live: live);

      await repo.loadOlder('sess-x', before: 42, limit: 25);

      expect(api.calls.last, <Object?>['sess-x', 42, 25]);

      await live.stop();
    });
  });
}
