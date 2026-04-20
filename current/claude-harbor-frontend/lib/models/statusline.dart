import 'package:meta/meta.dart';

import 'rate_limits.dart';

/// Live statusline snapshot delivered via `WS /subscribe` with type
/// `statusline.updated`. Mirrors the server `StatuslineBroadcast` shape
/// (see `event-bus.ts`), plus `sessionId` promoted from the envelope.
@immutable
class Statusline {
  final String sessionId;
  final String? latestModel;
  final String? latestModelDisplay;
  final String? latestVersion;
  final String? latestPermissionMode;
  final double? latestCtxPct;
  final int? latestCtxWindowSize;
  final String? latestLimitsJson;
  final double? latestCostUsd;
  final int? latestStatuslineAt;

  const Statusline({
    required this.sessionId,
    required this.latestModel,
    required this.latestModelDisplay,
    required this.latestVersion,
    required this.latestPermissionMode,
    required this.latestCtxPct,
    required this.latestCtxWindowSize,
    required this.latestLimitsJson,
    required this.latestCostUsd,
    required this.latestStatuslineAt,
  });

  /// Parsed rate-limits, or null when missing/invalid.
  RateLimits? get rateLimits => RateLimits.fromJsonString(latestLimitsJson);

  /// Parse the inner `statusline` object of a `statusline.updated` WS frame.
  ///
  /// [sessionId] comes from the envelope (WS frame's top-level `session_id`)
  /// and is injected into the returned model.
  factory Statusline.fromJson({
    required String sessionId,
    required Map<String, dynamic> statusline,
  }) {
    int? asInt(Object? v) {
      if (v is num) return v.toInt();
      if (v is String) return int.tryParse(v);
      return null;
    }

    double? asDouble(Object? v) {
      if (v is num) return v.toDouble();
      if (v is String) return double.tryParse(v);
      return null;
    }

    return Statusline(
      sessionId: sessionId,
      latestModel: statusline['latest_model'] as String?,
      latestModelDisplay: statusline['latest_model_display'] as String?,
      latestVersion: statusline['latest_version'] as String?,
      latestPermissionMode: statusline['latest_permission_mode'] as String?,
      latestCtxPct: asDouble(statusline['latest_ctx_pct']),
      latestCtxWindowSize: asInt(statusline['latest_ctx_window_size']),
      latestLimitsJson: statusline['latest_limits_json'] as String?,
      latestCostUsd: asDouble(statusline['latest_cost_usd']),
      latestStatuslineAt: asInt(statusline['latest_statusline_at']),
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Statusline &&
        other.sessionId == sessionId &&
        other.latestModel == latestModel &&
        other.latestModelDisplay == latestModelDisplay &&
        other.latestVersion == latestVersion &&
        other.latestPermissionMode == latestPermissionMode &&
        other.latestCtxPct == latestCtxPct &&
        other.latestCtxWindowSize == latestCtxWindowSize &&
        other.latestLimitsJson == latestLimitsJson &&
        other.latestCostUsd == latestCostUsd &&
        other.latestStatuslineAt == latestStatuslineAt;
  }

  @override
  int get hashCode => Object.hashAll(<Object?>[
        sessionId,
        latestModel,
        latestModelDisplay,
        latestVersion,
        latestPermissionMode,
        latestCtxPct,
        latestCtxWindowSize,
        latestLimitsJson,
        latestCostUsd,
        latestStatuslineAt,
      ]);

  @override
  String toString() =>
      'Statusline(session: $sessionId, model: $latestModel, ctxPct: $latestCtxPct)';
}
