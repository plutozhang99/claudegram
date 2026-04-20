import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:meta/meta.dart';

import '../models/message.dart';
import '../models/session.dart';

/// HTTP failure from the harbor server REST surface.
@immutable
class HarborApiException implements Exception {
  final int statusCode;

  /// Raw response body, unbounded. Prefer [toString] in user-facing
  /// contexts (it truncates to 200 chars). Keep full body available here
  /// for debugging and audit trails.
  final String body;

  const HarborApiException(this.statusCode, this.body);

  @override
  String toString() {
    final truncated =
        body.length > 200 ? '${body.substring(0, 200)}…' : body;
    return 'HarborApiException(statusCode: $statusCode, body: $truncated)';
  }
}

/// Envelope from `GET /sessions`.
class SessionListResponse {
  final List<Session> sessions;
  final int total;

  const SessionListResponse({required this.sessions, required this.total});
}

/// Envelope from `GET /sessions/:id`.
class SessionDetailResponse {
  final Session session;
  final int messagesCount;
  final int toolEventsCount;

  const SessionDetailResponse({
    required this.session,
    required this.messagesCount,
    required this.toolEventsCount,
  });
}

/// Envelope from `GET /sessions/:id/messages`.
class MessagePage {
  final List<Message> messages;
  final int? nextBefore;

  const MessagePage({required this.messages, required this.nextBefore});
}

/// Default per-request timeout.
const Duration _kDefaultTimeout = Duration(seconds: 10);

/// Strip nulls; `Uri` handles component encoding.
Map<String, String> _compactQuery(Map<String, String?> params) {
  final out = <String, String>{};
  params.forEach((k, v) {
    if (v != null) out[k] = v;
  });
  return out;
}

/// Low-level REST client against the harbor server.
///
/// All non-2xx responses are surfaced as [HarborApiException]. The client
/// owns its underlying [http.Client] when none is supplied and disposes it
/// in [close]; injected clients are left alone.
class HarborApiClient {
  final Uri baseUri;
  final http.Client _http;
  final bool _ownsClient;
  final Duration timeout;

  HarborApiClient({
    required this.baseUri,
    http.Client? httpClient,
    this.timeout = _kDefaultTimeout,
  })  : _http = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  /// Resolve [path] (must start with `/`) against [baseUri], attaching
  /// [queryParameters] via the `Uri` builder so encoding is handled
  /// correctly and path-traversal / stray fragments can't leak in.
  Uri _resolve(
    String path, {
    Map<String, String> queryParameters = const <String, String>{},
  }) {
    final base = baseUri;
    final basePath = base.path.endsWith('/') && base.path.length > 1
        ? base.path.substring(0, base.path.length - 1)
        : base.path;
    return base.replace(
      path: '$basePath$path',
      queryParameters: queryParameters.isEmpty ? null : queryParameters,
      fragment: '',
    );
  }

  Future<Map<String, dynamic>> _getJson(Uri uri) async {
    final res = await _http.get(uri).timeout(timeout);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw HarborApiException(res.statusCode, res.body);
    }
    return _decodeObject(res.body);
  }

  Map<String, dynamic> _decodeObject(String body) {
    final decoded = json.decode(body);
    if (decoded is! Map<String, dynamic>) {
      throw HarborApiException(
        500,
        'expected JSON object, got ${decoded.runtimeType}',
      );
    }
    return decoded;
  }

  /// GET /sessions?status=&limit=&offset=
  Future<SessionListResponse> listSessions({
    String? status,
    int? limit,
    int? offset,
  }) async {
    final uri = _resolve(
      '/sessions',
      queryParameters: _compactQuery(<String, String?>{
        'status': status,
        'limit': limit?.toString(),
        'offset': offset?.toString(),
      }),
    );
    final data = await _getJson(uri);
    final rawList = data['sessions'];
    if (rawList is! List) {
      throw const HarborApiException(500, 'sessions field not a list');
    }
    final sessions = rawList
        .whereType<Map<String, dynamic>>()
        .map(Session.fromJson)
        .toList(growable: false);
    final total = (data['total'] as num?)?.toInt() ?? sessions.length;
    return SessionListResponse(sessions: sessions, total: total);
  }

  /// GET /sessions/:id
  Future<SessionDetailResponse> getSession(String sessionId) async {
    final uri = _resolve('/sessions/${Uri.encodeComponent(sessionId)}');
    final data = await _getJson(uri);
    final sessionRaw = data['session'];
    if (sessionRaw is! Map<String, dynamic>) {
      throw const HarborApiException(500, 'session field not an object');
    }
    final countsRaw = data['counts'];
    final counts = countsRaw is Map<String, dynamic> ? countsRaw : const <String, dynamic>{};
    return SessionDetailResponse(
      session: Session.fromJson(sessionRaw),
      messagesCount: (counts['messages'] as num?)?.toInt() ?? 0,
      toolEventsCount: (counts['tool_events'] as num?)?.toInt() ?? 0,
    );
  }

  /// GET /sessions/:id/messages?before=&limit=
  Future<MessagePage> listMessages(
    String sessionId, {
    int? before,
    int? limit,
  }) async {
    final uri = _resolve(
      '/sessions/${Uri.encodeComponent(sessionId)}/messages',
      queryParameters: _compactQuery(<String, String?>{
        'before': before?.toString(),
        'limit': limit?.toString(),
      }),
    );
    final data = await _getJson(uri);
    final rawList = data['messages'];
    if (rawList is! List) {
      throw const HarborApiException(500, 'messages field not a list');
    }
    final messages = rawList
        .whereType<Map<String, dynamic>>()
        .map(Message.fromJson)
        .toList(growable: false);
    final nextBefore = (data['next_before'] as num?)?.toInt();
    return MessagePage(messages: messages, nextBefore: nextBefore);
  }

  /// POST /channel/reply
  ///
  /// Auth material ([channelToken]) must be supplied by the caller. The
  /// frontend never stores the token alongside public session rows — the
  /// detail screen fetches it via an authenticated admin endpoint.
  Future<void> postChannelReply({
    required String channelToken,
    required String content,
    Map<String, String>? meta,
  }) async {
    final uri = _resolve('/channel/reply');
    final body = <String, dynamic>{
      'channel_token': channelToken,
      'content': content,
      if (meta != null) 'meta': meta,
    };
    final res = await _http
        .post(
          uri,
          headers: const <String, String>{'content-type': 'application/json'},
          body: json.encode(body),
        )
        .timeout(timeout);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw HarborApiException(res.statusCode, res.body);
    }
  }

  /// GET /admin/session/:sessionId — returns the per-session `channel_token`.
  ///
  /// Loopback admin endpoints work without a token; pass [adminToken] as
  /// `x-harbor-admin-token` header when the server binds to non-loopback.
  /// Throws [HarborApiException] on non-2xx responses (401 → admin token
  /// required / rotated).
  Future<String> adminFetchChannelToken(
    String sessionId, {
    String? adminToken,
  }) async {
    final uri = _resolve('/admin/session/${Uri.encodeComponent(sessionId)}');
    final headers = <String, String>{
      if (adminToken != null && adminToken.isNotEmpty)
        'x-harbor-admin-token': adminToken,
    };
    final res =
        await _http.get(uri, headers: headers).timeout(timeout);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw HarborApiException(res.statusCode, res.body);
    }
    final data = _decodeObject(res.body);
    final sessionRaw = data['session'];
    if (sessionRaw is! Map<String, dynamic>) {
      throw const HarborApiException(500, 'admin session field not an object');
    }
    final token = sessionRaw['channel_token'];
    if (token is! String || token.isEmpty) {
      throw const HarborApiException(500, 'channel_token missing');
    }
    return token;
  }

  /// Release the underlying http.Client (only if we own it).
  void close() {
    if (_ownsClient) _http.close();
  }
}
