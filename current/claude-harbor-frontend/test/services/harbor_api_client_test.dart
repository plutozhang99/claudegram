import 'dart:convert';

import 'package:claude_harbor_frontend/services/harbor_api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mocktail/mocktail.dart';

class _MockHttpClient extends Mock implements http.Client {}

class _FakeUri extends Fake implements Uri {}

http.Response _json(int status, Object body) =>
    http.Response(json.encode(body), status,
        headers: const <String, String>{'content-type': 'application/json'});

void main() {
  setUpAll(() {
    registerFallbackValue(_FakeUri());
  });

  group('HarborApiClient', () {
    late _MockHttpClient http_;
    late HarborApiClient client;

    setUp(() {
      http_ = _MockHttpClient();
      client = HarborApiClient(
        baseUri: Uri.parse('http://127.0.0.1:1234'),
        httpClient: http_,
      );
    });

    test('listSessions default (no filters) hits /sessions', () async {
      when(() => http_.get(any())).thenAnswer((_) async => _json(200, {
            'sessions': [
              {
                'session_id': 'a',
                'started_at': 1,
                'status': 'active',
              },
            ],
            'total': 1,
          }));
      final res = await client.listSessions();
      expect(res.total, 1);
      expect(res.sessions, hasLength(1));
      final captured = verify(() => http_.get(captureAny())).captured.single as Uri;
      expect(captured.path, '/sessions');
      expect(captured.query, isEmpty);
    });

    test('listSessions passes status/limit/offset query params', () async {
      when(() => http_.get(any())).thenAnswer((_) async => _json(200, {
            'sessions': <Map<String, dynamic>>[],
            'total': 0,
          }));
      await client.listSessions(status: 'active', limit: 10, offset: 20);
      final captured = verify(() => http_.get(captureAny())).captured.single as Uri;
      expect(captured.queryParameters['status'], 'active');
      expect(captured.queryParameters['limit'], '10');
      expect(captured.queryParameters['offset'], '20');
    });

    test('getSession returns session+counts on 200', () async {
      when(() => http_.get(any())).thenAnswer((_) async => _json(200, {
            'session': {
              'session_id': 'abc',
              'started_at': 1,
              'status': 'active',
            },
            'counts': {'messages': 5, 'tool_events': 2},
          }));
      final res = await client.getSession('abc');
      expect(res.session.sessionId, 'abc');
      expect(res.messagesCount, 5);
      expect(res.toolEventsCount, 2);
    });

    test('getSession throws HarborApiException on 404', () async {
      when(() => http_.get(any()))
          .thenAnswer((_) async => http.Response('not found', 404));
      expect(
        () => client.getSession('missing'),
        throwsA(isA<HarborApiException>()
            .having((e) => e.statusCode, 'statusCode', 404)),
      );
    });

    test('listMessages echoes pagination params', () async {
      when(() => http_.get(any())).thenAnswer((_) async => _json(200, {
            'messages': [
              {
                'id': 9,
                'session_id': 'sess',
                'direction': 'inbound',
                'content': 'x',
                'meta_json': null,
                'created_at': 1,
              },
            ],
            'next_before': 9,
          }));
      final page = await client.listMessages('sess', before: 100, limit: 50);
      expect(page.messages, hasLength(1));
      expect(page.nextBefore, 9);
      final captured = verify(() => http_.get(captureAny())).captured.single as Uri;
      expect(captured.path, '/sessions/sess/messages');
      expect(captured.queryParameters['before'], '100');
      expect(captured.queryParameters['limit'], '50');
    });

    test('postChannelReply succeeds on 204', () async {
      when(() => http_.post(any(),
              headers: any(named: 'headers'), body: any(named: 'body')))
          .thenAnswer((_) async => http.Response('', 204));
      await client.postChannelReply(channelToken: 'tok', content: 'hi');
      final capArgs = verify(() => http_.post(
            captureAny(),
            headers: captureAny(named: 'headers'),
            body: captureAny(named: 'body'),
          )).captured;
      final uri = capArgs[0] as Uri;
      expect(uri.path, '/channel/reply');
      final body = json.decode(capArgs[2] as String) as Map<String, dynamic>;
      expect(body['channel_token'], 'tok');
      expect(body['content'], 'hi');
    });

    test('listSessions throws HarborApiException on 401', () async {
      when(() => http_.get(any()))
          .thenAnswer((_) async => http.Response('unauthorized', 401));
      expect(
        () => client.listSessions(),
        throwsA(isA<HarborApiException>()
            .having((e) => e.statusCode, 'statusCode', 401)),
      );
    });

    test('listMessages throws HarborApiException on 401', () async {
      when(() => http_.get(any()))
          .thenAnswer((_) async => http.Response('unauthorized', 401));
      expect(
        () => client.listMessages('sess'),
        throwsA(isA<HarborApiException>()
            .having((e) => e.statusCode, 'statusCode', 401)),
      );
    });

    test('postChannelReply throws on 401', () async {
      when(() => http_.post(any(),
              headers: any(named: 'headers'), body: any(named: 'body')))
          .thenAnswer((_) async => http.Response('nope', 401));
      expect(
        () => client.postChannelReply(channelToken: 'bad', content: 'x'),
        throwsA(isA<HarborApiException>()
            .having((e) => e.statusCode, 'statusCode', 401)),
      );
    });
  });
}
