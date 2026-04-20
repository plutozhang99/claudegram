import 'package:meta/meta.dart';

import 'rate_limits.dart';

/// Safe int coerce: accepts int or numeric string; returns null otherwise.
int? _asInt(Object? v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v);
  return null;
}

/// Safe double coerce: accepts num or numeric string; returns null otherwise.
double? _asDouble(Object? v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

String? _asString(Object? v) {
  if (v == null) return null;
  return v is String ? v : v.toString();
}

/// Flutter-side mirror of `PublicSessionRow` (server `db-queries.ts`).
///
/// The server projection strips `channel_token`, so this class does NOT
/// carry it. Reply auth is threaded separately — see
/// `HarborApiClient.postChannelReply`.
@immutable
class Session {
  final String sessionId;
  final String? cwd;
  final int? pid;
  final String? projectDir;
  final String? accountHint;
  final int startedAt;
  final int? endedAt;
  final String? endedReason;
  final String? latestModel;
  final String? latestModelDisplay;
  final String? latestVersion;
  final String? latestPermissionMode;
  final double? latestCtxPct;
  final int? latestCtxWindowSize;
  final String? latestLimitsJson;
  final double? latestCostUsd;
  final int? latestStatuslineAt;
  final String status;

  const Session({
    required this.sessionId,
    required this.cwd,
    required this.pid,
    required this.projectDir,
    required this.accountHint,
    required this.startedAt,
    required this.endedAt,
    required this.endedReason,
    required this.latestModel,
    required this.latestModelDisplay,
    required this.latestVersion,
    required this.latestPermissionMode,
    required this.latestCtxPct,
    required this.latestCtxWindowSize,
    required this.latestLimitsJson,
    required this.latestCostUsd,
    required this.latestStatuslineAt,
    required this.status,
  });

  /// Parsed representation of [latestLimitsJson], or null if missing/invalid.
  RateLimits? get rateLimits => RateLimits.fromJsonString(latestLimitsJson);

  factory Session.fromJson(Map<String, dynamic> json) {
    final rawSessionId = json['session_id'];
    if (rawSessionId is! String) {
      throw const FormatException('Session.session_id missing or not a String');
    }
    final startedAt = _asInt(json['started_at']);
    if (startedAt == null) {
      throw const FormatException('Session.started_at missing or not an int');
    }
    return Session(
      sessionId: rawSessionId,
      cwd: _asString(json['cwd']),
      pid: _asInt(json['pid']),
      projectDir: _asString(json['project_dir']),
      accountHint: _asString(json['account_hint']),
      startedAt: startedAt,
      endedAt: _asInt(json['ended_at']),
      endedReason: _asString(json['ended_reason']),
      latestModel: _asString(json['latest_model']),
      latestModelDisplay: _asString(json['latest_model_display']),
      latestVersion: _asString(json['latest_version']),
      latestPermissionMode: _asString(json['latest_permission_mode']),
      latestCtxPct: _asDouble(json['latest_ctx_pct']),
      latestCtxWindowSize: _asInt(json['latest_ctx_window_size']),
      latestLimitsJson: _asString(json['latest_limits_json']),
      latestCostUsd: _asDouble(json['latest_cost_usd']),
      latestStatuslineAt: _asInt(json['latest_statusline_at']),
      status: (json['status'] as String?) ?? 'active',
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'session_id': sessionId,
        'cwd': cwd,
        'pid': pid,
        'project_dir': projectDir,
        'account_hint': accountHint,
        'started_at': startedAt,
        'ended_at': endedAt,
        'ended_reason': endedReason,
        'latest_model': latestModel,
        'latest_model_display': latestModelDisplay,
        'latest_version': latestVersion,
        'latest_permission_mode': latestPermissionMode,
        'latest_ctx_pct': latestCtxPct,
        'latest_ctx_window_size': latestCtxWindowSize,
        'latest_limits_json': latestLimitsJson,
        'latest_cost_usd': latestCostUsd,
        'latest_statusline_at': latestStatuslineAt,
        'status': status,
      };

  Session copyWith({
    String? sessionId,
    String? cwd,
    int? pid,
    String? projectDir,
    String? accountHint,
    int? startedAt,
    int? Function()? endedAt,
    String? Function()? endedReason,
    String? Function()? latestModel,
    String? Function()? latestModelDisplay,
    String? Function()? latestVersion,
    String? Function()? latestPermissionMode,
    double? Function()? latestCtxPct,
    int? Function()? latestCtxWindowSize,
    String? Function()? latestLimitsJson,
    double? Function()? latestCostUsd,
    int? Function()? latestStatuslineAt,
    String? status,
  }) {
    return Session(
      sessionId: sessionId ?? this.sessionId,
      cwd: cwd ?? this.cwd,
      pid: pid ?? this.pid,
      projectDir: projectDir ?? this.projectDir,
      accountHint: accountHint ?? this.accountHint,
      startedAt: startedAt ?? this.startedAt,
      endedAt: endedAt != null ? endedAt() : this.endedAt,
      endedReason: endedReason != null ? endedReason() : this.endedReason,
      latestModel: latestModel != null ? latestModel() : this.latestModel,
      latestModelDisplay: latestModelDisplay != null
          ? latestModelDisplay()
          : this.latestModelDisplay,
      latestVersion:
          latestVersion != null ? latestVersion() : this.latestVersion,
      latestPermissionMode: latestPermissionMode != null
          ? latestPermissionMode()
          : this.latestPermissionMode,
      latestCtxPct:
          latestCtxPct != null ? latestCtxPct() : this.latestCtxPct,
      latestCtxWindowSize: latestCtxWindowSize != null
          ? latestCtxWindowSize()
          : this.latestCtxWindowSize,
      latestLimitsJson: latestLimitsJson != null
          ? latestLimitsJson()
          : this.latestLimitsJson,
      latestCostUsd:
          latestCostUsd != null ? latestCostUsd() : this.latestCostUsd,
      latestStatuslineAt: latestStatuslineAt != null
          ? latestStatuslineAt()
          : this.latestStatuslineAt,
      status: status ?? this.status,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Session &&
        other.sessionId == sessionId &&
        other.cwd == cwd &&
        other.pid == pid &&
        other.projectDir == projectDir &&
        other.accountHint == accountHint &&
        other.startedAt == startedAt &&
        other.endedAt == endedAt &&
        other.endedReason == endedReason &&
        other.latestModel == latestModel &&
        other.latestModelDisplay == latestModelDisplay &&
        other.latestVersion == latestVersion &&
        other.latestPermissionMode == latestPermissionMode &&
        other.latestCtxPct == latestCtxPct &&
        other.latestCtxWindowSize == latestCtxWindowSize &&
        other.latestLimitsJson == latestLimitsJson &&
        other.latestCostUsd == latestCostUsd &&
        other.latestStatuslineAt == latestStatuslineAt &&
        other.status == status;
  }

  @override
  int get hashCode => Object.hashAll(<Object?>[
        sessionId,
        cwd,
        pid,
        projectDir,
        accountHint,
        startedAt,
        endedAt,
        endedReason,
        latestModel,
        latestModelDisplay,
        latestVersion,
        latestPermissionMode,
        latestCtxPct,
        latestCtxWindowSize,
        latestLimitsJson,
        latestCostUsd,
        latestStatuslineAt,
        status,
      ]);

  @override
  String toString() =>
      'Session(sessionId: $sessionId, status: $status, model: $latestModel)';
}
