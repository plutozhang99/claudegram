import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:meta/meta.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/message.dart';
import '../models/session.dart';
import '../models/statusline.dart';

/// Liveness state of the subscriber WS.
enum HarborConnectionState { connecting, connected, disconnected, error }

/// Sealed union of all events the frontend cares about.
sealed class HarborEvent {
  const HarborEvent();
}

class SubscribedAck extends HarborEvent {
  const SubscribedAck();
}

class SessionCreated extends HarborEvent {
  final Session session;
  const SessionCreated(this.session);
}

class SessionUpdated extends HarborEvent {
  final Session session;
  const SessionUpdated(this.session);
}

class SessionEnded extends HarborEvent {
  final String sessionId;
  const SessionEnded(this.sessionId);
}

class MessageCreated extends HarborEvent {
  final String sessionId;
  final Message message;
  const MessageCreated({required this.sessionId, required this.message});
}

class StatuslineUpdated extends HarborEvent {
  final String sessionId;
  final Statusline statusline;
  const StatuslineUpdated({required this.sessionId, required this.statusline});
}

class ConnectionStateChanged extends HarborEvent {
  final HarborConnectionState state;
  const ConnectionStateChanged(this.state);
}

/// Factory signature to allow tests to inject a fake WebSocketChannel.
typedef WebSocketChannelFactory = WebSocketChannel Function(Uri uri);

WebSocketChannel _defaultChannelFactory(Uri uri) =>
    WebSocketChannel.connect(uri);

/// WS subscription manager with auto-reconnect + 45s heartbeat watchdog.
///
/// Multiplexes all server frames into a single broadcast [events] stream
/// keyed by [HarborEvent] subclasses. Unknown event types are dropped.
@internal
const Duration kHeartbeatTimeout = Duration(seconds: 45);

class HarborLiveService {
  final Uri wsUri;
  final Duration reconnectDelay;
  final Duration maxReconnectDelay;
  final WebSocketChannelFactory _channelFactory;
  final Duration _heartbeatTimeout;

  final StreamController<HarborEvent> _eventsCtrl =
      StreamController<HarborEvent>.broadcast();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _channelSub;
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;
  Duration _currentBackoff;
  bool _started = false;
  bool _stopping = false;
  // Reconnect-cycle debounce: true between a decision to reconnect
  // (inside [_onFailure]) and the moment [_connect] actually fires.
  // Prevents overlapping `onError` + `onDone` callbacks from doubling
  // the backoff or scheduling two reconnect timers.
  bool _reconnectPending = false;

  /// Reconnect state machine:
  ///
  ///   start() -> _connect() (initial)
  ///       |
  ///       v
  ///   [connected]  --- frame with valid app-level event --> reset backoff
  ///       |
  ///       | onError/onDone/heartbeat timeout
  ///       v
  ///   _onFailure()  -- sets _reconnectPending=true (idempotent)
  ///       |
  ///       v
  ///   _scheduleReconnect()  -- computes NEXT backoff once, arms timer
  ///       |
  ///       v
  ///   _connect()  -- clears _reconnectPending
  ///
  /// Invariants:
  /// - Backoff doubles exactly once per failure->reconnect transition.
  /// - `_currentBackoff` resets ONLY after a successfully parsed and
  ///   emitted application-level event (not on raw frames / binary frames
  ///   / malformed JSON).
  /// - `_reconnectPending` guarantees overlapping onError+onDone cannot
  ///   schedule two reconnect timers.

  HarborLiveService({
    required this.wsUri,
    this.reconnectDelay = const Duration(seconds: 2),
    this.maxReconnectDelay = const Duration(seconds: 30),
    WebSocketChannelFactory? channelFactory,
    Duration? heartbeatTimeout,
  })  : _channelFactory = channelFactory ?? _defaultChannelFactory,
        _heartbeatTimeout = heartbeatTimeout ?? kHeartbeatTimeout,
        _currentBackoff = reconnectDelay;

  /// All live events, including connection-state transitions.
  Stream<HarborEvent> get events => _eventsCtrl.stream;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    _stopping = false;
    _connect();
  }

  Future<void> stop() async {
    _stopping = true;
    _started = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    await _channelSub?.cancel();
    _channelSub = null;
    try {
      await _channel?.sink.close();
    } catch (_) {
      // ignore
    }
    _channel = null;
    if (!_eventsCtrl.isClosed) {
      await _eventsCtrl.close();
    }
  }

  void _emit(HarborEvent ev) {
    if (_eventsCtrl.isClosed) return;
    _eventsCtrl.add(ev);
  }

  void _connect() {
    if (_stopping) return;
    _reconnectPending = false;
    _emit(const ConnectionStateChanged(HarborConnectionState.connecting));
    WebSocketChannel channel;
    try {
      channel = _channelFactory(wsUri);
    } catch (_) {
      _onFailure();
      return;
    }
    _channel = channel;
    _channelSub = channel.stream.listen(
      _onFrame,
      onError: (_, __) => _onFailure(),
      onDone: _onFailure,
      cancelOnError: true,
    );
    _emit(const ConnectionStateChanged(HarborConnectionState.connected));
    _armHeartbeat();
  }

  void _armHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer(_heartbeatTimeout, () {
      // No frame received in window; force a reconnect cycle.
      _onFailure();
    });
  }

  void _onFrame(dynamic raw) {
    // Any frame keeps us alive (heartbeat watchdog only — does NOT
    // imply the frame was a well-formed application event).
    _armHeartbeat();
    if (raw is! String) return;
    Object? decoded;
    try {
      decoded = json.decode(raw);
    } catch (e) {
      developer.log('harbor: json decode failed: $e', name: 'harbor.live');
      return;
    }
    if (decoded is! Map<String, dynamic>) return;
    final type = decoded['type'];
    if (type is! String) {
      developer.log('harbor: frame missing string type field',
          name: 'harbor.live');
      return;
    }
    final event = _decodeEvent(type, decoded);
    if (event == null) return;
    // Successful application-level event: reset backoff so a later
    // failure starts from the initial delay again.
    _currentBackoff = reconnectDelay;
    _emit(event);
  }

  HarborEvent? _decodeEvent(String type, Map<String, dynamic> frame) {
    try {
      switch (type) {
        case 'subscribed':
          return const SubscribedAck();
        case 'session.created':
          final s = frame['session'];
          if (s is Map<String, dynamic>) {
            return SessionCreated(Session.fromJson(s));
          }
          return null;
        case 'session.updated':
          final s = frame['session'];
          if (s is Map<String, dynamic>) {
            return SessionUpdated(Session.fromJson(s));
          }
          return null;
        case 'session.ended':
          final sid = frame['session_id'];
          if (sid is String) return SessionEnded(sid);
          return null;
        case 'message.created':
          final sid = frame['session_id'];
          final msg = frame['message'];
          if (sid is String && msg is Map<String, dynamic>) {
            // Message payload omits session_id in some codepaths — inject.
            final merged = <String, dynamic>{'session_id': sid, ...msg};
            return MessageCreated(
              sessionId: sid,
              message: Message.fromJson(merged),
            );
          }
          return null;
        case 'statusline.updated':
          final sid = frame['session_id'];
          final sl = frame['statusline'];
          if (sid is String && sl is Map<String, dynamic>) {
            return StatuslineUpdated(
              sessionId: sid,
              statusline: Statusline.fromJson(sessionId: sid, statusline: sl),
            );
          }
          return null;
        default:
          developer.log('harbor: unknown event type $type',
              name: 'harbor.live');
          return null;
      }
    } on FormatException catch (e) {
      developer.log('harbor: malformed $type frame: $e', name: 'harbor.live');
      return null;
    } on TypeError catch (e) {
      developer.log('harbor: type error decoding $type: $e',
          name: 'harbor.live');
      return null;
    } on ArgumentError catch (e) {
      developer.log('harbor: bad argument decoding $type: $e',
          name: 'harbor.live');
      return null;
    }
  }

  void _onFailure() {
    if (_stopping) return;
    // Debounce overlapping onError + onDone + heartbeat-timeout callbacks
    // that can all fire for a single socket death. Only the first wins.
    if (_reconnectPending) return;
    _reconnectPending = true;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _channelSub?.cancel();
    _channelSub = null;
    try {
      _channel?.sink.close();
    } catch (_) {
      // ignore
    }
    _channel = null;
    _emit(const ConnectionStateChanged(HarborConnectionState.disconnected));
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_stopping) return;
    _reconnectTimer?.cancel();
    // Use the CURRENT backoff for this reconnect wait. Compute the
    // NEXT backoff exactly once per transition so that overlapping
    // onError + onDone cannot double-advance it (guarded by
    // _reconnectPending above).
    final delay = _currentBackoff;
    final nextMs = (_currentBackoff.inMilliseconds * 2)
        .clamp(reconnectDelay.inMilliseconds, maxReconnectDelay.inMilliseconds);
    _currentBackoff = Duration(milliseconds: nextMs);
    _reconnectTimer = Timer(delay, _connect);
  }
}
