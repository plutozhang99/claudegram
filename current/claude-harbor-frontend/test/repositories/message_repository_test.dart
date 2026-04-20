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

  @override
  Uri get baseUri => Uri.parse('http://fake');

  @override
  Duration get timeout => const Duration(seconds: 10);

  @override
  Future<MessagePage> listMessages(String s, {int? before, int? limit}) async {
    calls.add(<Object?>[s, before, limit]);
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
}
