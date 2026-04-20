import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/message.dart';
import '../models/session.dart';
import '../repositories/message_repository.dart';
import '../repositories/session_repository.dart';
import '../services/harbor_api_client.dart';
import '../services/harbor_live_service.dart';

/// Base URI of the harbor server. Defaults to [Uri.base] since the Flutter
/// bundle is served from the same Bun origin in P2.5; overridable in tests.
///
/// Non-web platforms (desktop/mobile) MUST override this provider — on
/// those platforms `Uri.base` is the process `cwd://` URI, not an http
/// origin. A future release may read `--dart-define=HARBOR_BASE_URI=...`
/// as a built-in override.
final Provider<Uri> harborBaseUriProvider = Provider<Uri>((ref) {
  final base = Uri.base;
  if (base.scheme != 'http' && base.scheme != 'https') {
    throw StateError(
      'harborBaseUriProvider must be overridden on non-web platforms '
      '(got ${base.scheme}:// base). Override in tests and non-web builds.',
    );
  }
  return base;
});

/// WS subscribe URI — derived from the base URI by swapping scheme and
/// appending `/subscribe`. Query and fragment are cleared so hash-routed
/// app state (e.g. `#/sessions/abc`) never leaks into the WS URL.
final Provider<Uri> harborWsUriProvider = Provider<Uri>((ref) {
  final base = ref.watch(harborBaseUriProvider);
  final scheme = base.scheme == 'https' ? 'wss' : 'ws';
  return base.replace(
    scheme: scheme,
    path: '/subscribe',
    query: '',
    fragment: '',
  );
});

final Provider<HarborApiClient> harborApiClientProvider =
    Provider<HarborApiClient>((ref) {
  final client = HarborApiClient(baseUri: ref.watch(harborBaseUriProvider));
  // client.close() is synchronous — no unawaited() needed.
  ref.onDispose(client.close);
  return client;
});

final Provider<HarborLiveService> harborLiveServiceProvider =
    Provider<HarborLiveService>((ref) {
  final svc = HarborLiveService(wsUri: ref.watch(harborWsUriProvider));
  // start() completes synchronously after scheduling the async connect;
  // wrap in unawaited() to document that we intentionally drop the Future.
  unawaited(svc.start());
  ref.onDispose(() {
    unawaited(svc.stop());
  });
  return svc;
});

final Provider<SessionRepository> sessionRepositoryProvider =
    Provider<SessionRepository>((ref) {
  return SessionRepository(
    api: ref.watch(harborApiClientProvider),
    live: ref.watch(harborLiveServiceProvider),
  );
});

final Provider<MessageRepository> messageRepositoryProvider =
    Provider<MessageRepository>((ref) {
  return MessageRepository(
    api: ref.watch(harborApiClientProvider),
    live: ref.watch(harborLiveServiceProvider),
  );
});

/// Live list of sessions. Default status filter is `all`.
final StreamProvider<List<Session>> sessionListProvider =
    StreamProvider<List<Session>>((ref) {
  final repo = ref.watch(sessionRepositoryProvider);
  return repo.watchList();
});

/// Snapshot fetch for the detail screen. Live updates during the session's
/// lifetime are layered on top by screens that also watch [sessionListProvider].
final FutureProviderFamily<Session, String> sessionDetailProvider =
    FutureProvider.family<Session, String>((ref, id) {
  final repo = ref.watch(sessionRepositoryProvider);
  return repo.fetchOne(id);
});

/// Live stream of new inbound/outbound messages for a specific session.
///
/// Emits one [Message] per `MessageCreated` event. Useful for narrow
/// listeners (e.g. a "new message" badge). For the chat pane use
/// [messagesProvider], which gives the full chronologically-sorted list.
final StreamProviderFamily<Message, String> messageInboxProvider =
    StreamProvider.family<Message, String>((ref, sessionId) {
  final repo = ref.watch(messageRepositoryProvider);
  return repo.watchInbox(sessionId);
});

/// Chronological list of messages for a session — REST backfill + live
/// appends merged into one sorted, deduped list. Intended for the P2.4
/// detail chat pane. `autoDispose` + explicit `disposeSession` in
/// onDispose means the repo-side feed cache is released when nothing
/// is listening, so live subscriptions and stream controllers don't leak.
final AutoDisposeStreamProviderFamily<List<Message>, String> messagesProvider =
    StreamProvider.autoDispose.family<List<Message>, String>((ref, sessionId) {
  final repo = ref.watch(messageRepositoryProvider);
  ref.onDispose(() {
    unawaited(repo.disposeSession(sessionId));
  });
  return repo.watchMessages(sessionId);
});

/// Optional admin token used to authenticate against `/admin/*` endpoints
/// (e.g. fetching the per-session `channel_token` for the compose box).
///
/// Read once at startup from `--dart-define=HARBOR_ADMIN_TOKEN=...`.
/// Returns `null` when the compile-time value is empty — loopback admin
/// calls work without a token, so an unset value is valid in dev.
///
/// NOTE: This value is compile-time embedded in the JS bundle shipped to
/// the browser. Only safe for loopback / single-operator deployments —
/// do not use this mechanism for a multi-tenant or public-facing harbor.
final Provider<String?> harborAdminTokenProvider = Provider<String?>((ref) {
  const String value = String.fromEnvironment('HARBOR_ADMIN_TOKEN');
  if (value.isEmpty) return null;
  return value;
});
