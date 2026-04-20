import 'dart:async';
import 'dart:convert';

import 'package:claude_harbor_frontend/services/harbor_live_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Minimal in-memory fake WS channel. Only the subset of [WebSocketChannel]
/// that [HarborLiveService] actually reaches is implemented; everything else
/// is routed through [noSuchMethod].
class _FakeChannel implements WebSocketChannel {
  final StreamController<dynamic> _incoming =
      StreamController<dynamic>.broadcast();
  final _FakeSink _sink = _FakeSink();
  bool closed = false;

  void pushFrame(Object frame) {
    if (closed) return;
    _incoming.add(frame);
  }

  void closeFromServer() {
    if (closed) return;
    closed = true;
    _incoming.close();
  }

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  String? get protocol => null;
  @override
  Future<void> get ready => Future<void>.value();

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      super.noSuchMethod(invocation);
}

class _FakeSink implements WebSocketSink {
  bool closed = false;
  final List<Object?> sent = <Object?>[];

  @override
  void add(event) {
    sent.add(event);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future addStream(Stream stream) async {}

  @override
  Future close([int? closeCode, String? closeReason]) async {
    closed = true;
  }

  @override
  Future get done => Future<void>.value();
}

void main() {
  group('HarborLiveService', () {
    test('emits SubscribedAck on {type:"subscribed"} frame', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({'type': 'subscribed'}));
      await Future<void>.delayed(Duration.zero);
      expect(events.whereType<SubscribedAck>(), isNotEmpty);
      await sub.cancel();
      await svc.stop();
    });

    test('emits SessionCreated for session.created frame', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({
        'type': 'session.created',
        'session_id': 'abc',
        'session': {
          'session_id': 'abc',
          'started_at': 1,
          'status': 'active',
        },
      }));
      await Future<void>.delayed(Duration.zero);
      final created = events.whereType<SessionCreated>().toList();
      expect(created, hasLength(1));
      expect(created.single.session.sessionId, 'abc');
      await sub.cancel();
      await svc.stop();
    });

    test('emits SessionUpdated for session.updated frame', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({
        'type': 'session.updated',
        'session_id': 'abc',
        'session': {
          'session_id': 'abc',
          'started_at': 2,
          'status': 'active',
          'latest_model': 'claude-sonnet-4-6',
        },
      }));
      await Future<void>.delayed(Duration.zero);
      final updated = events.whereType<SessionUpdated>().toList();
      expect(updated, hasLength(1));
      expect(updated.single.session.sessionId, 'abc');
      expect(updated.single.session.latestModel, 'claude-sonnet-4-6');
      await sub.cancel();
      await svc.stop();
    });

    test('emits SessionEnded with session_id', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(
          json.encode({'type': 'session.ended', 'session_id': 'abc'}));
      await Future<void>.delayed(Duration.zero);
      final ended = events.whereType<SessionEnded>().toList();
      expect(ended, hasLength(1));
      expect(ended.single.sessionId, 'abc');
      await sub.cancel();
      await svc.stop();
    });

    test('emits MessageCreated with session_id + message payload', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({
        'type': 'message.created',
        'session_id': 'abc',
        'message': {
          'id': 42,
          'direction': 'inbound',
          'content': 'hello',
          'meta_json': null,
          'created_at': 1700000000000,
        },
      }));
      await Future<void>.delayed(Duration.zero);
      final msgs = events.whereType<MessageCreated>().toList();
      expect(msgs, hasLength(1));
      expect(msgs.single.sessionId, 'abc');
      expect(msgs.single.message.id, 42);
      expect(msgs.single.message.content, 'hello');
      await sub.cancel();
      await svc.stop();
    });

    test('emits StatuslineUpdated with sessionId + statusline snapshot',
        () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({
        'type': 'statusline.updated',
        'session_id': 'abc',
        'statusline': {
          'latest_model': 'claude-opus-4-7',
          'latest_ctx_pct': 33.3,
          'latest_statusline_at': 1700000000500,
        },
      }));
      await Future<void>.delayed(Duration.zero);
      final sl = events.whereType<StatuslineUpdated>().toList();
      expect(sl, hasLength(1));
      expect(sl.single.sessionId, 'abc');
      expect(sl.single.statusline.latestModel, 'claude-opus-4-7');
      expect(sl.single.statusline.latestCtxPct, 33.3);
      await sub.cancel();
      await svc.stop();
    });

    test('malformed app-level payload does not kill subscription', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      // session.created with a bogus session body (missing required fields).
      channel.pushFrame(json.encode({
        'type': 'session.created',
        'session': <String, dynamic>{'only': 'garbage'},
      }));
      // And then a well-formed frame afterward to prove the sub is still live.
      channel.pushFrame(json.encode({'type': 'subscribed'}));
      await Future<void>.delayed(Duration.zero);
      expect(events.whereType<SessionCreated>(), isEmpty);
      expect(events.whereType<SubscribedAck>(), isNotEmpty);
      await sub.cancel();
      await svc.stop();
    });

    test('drops unknown event types silently', () async {
      final channel = _FakeChannel();
      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        channelFactory: (_) => channel,
      );
      final events = <HarborEvent>[];
      final sub = svc.events.listen(events.add);
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(json.encode({'type': 'martian.ping', 'payload': 1}));
      await Future<void>.delayed(Duration.zero);
      // Only connection-state events should appear; no custom event type.
      expect(events.whereType<SubscribedAck>(), isEmpty);
      expect(events.whereType<SessionCreated>(), isEmpty);
      expect(events.whereType<SessionUpdated>(), isEmpty);
      await sub.cancel();
      await svc.stop();
    });

    test('reconnects after server close', () async {
      final channels = <_FakeChannel>[];
      _FakeChannel factory(Uri _) {
        final c = _FakeChannel();
        channels.add(c);
        return c;
      }

      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        reconnectDelay: const Duration(milliseconds: 5),
        maxReconnectDelay: const Duration(milliseconds: 20),
        channelFactory: factory,
      );
      final sub = svc.events.listen((_) {});
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      expect(channels, hasLength(1));
      channels.first.closeFromServer();
      // Wait long enough for the backoff + reconnect.
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(channels.length, greaterThanOrEqualTo(2));
      await sub.cancel();
      await svc.stop();
    });

    test('heartbeat triggers reconnect after timeout', () async {
      final channels = <_FakeChannel>[];
      _FakeChannel factory(Uri _) {
        final c = _FakeChannel();
        channels.add(c);
        return c;
      }

      final svc = HarborLiveService(
        wsUri: Uri.parse('ws://x/subscribe'),
        reconnectDelay: const Duration(milliseconds: 5),
        maxReconnectDelay: const Duration(milliseconds: 20),
        heartbeatTimeout: const Duration(milliseconds: 20),
        channelFactory: factory,
      );
      final sub = svc.events.listen((_) {});
      await svc.start();
      await Future<void>.delayed(Duration.zero);
      expect(channels, hasLength(1));
      // Do not push any frames; heartbeat must fire.
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(channels.length, greaterThanOrEqualTo(2));
      await sub.cancel();
      await svc.stop();
    });
  });
}
