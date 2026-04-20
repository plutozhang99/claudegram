import 'dart:convert';

import 'package:meta/meta.dart';

/// One rolling-window slice of Claude Code's rate-limits snapshot.
///
/// `usedPercentage` is the server-reported "% of quota used" (0..100, but we
/// clamp defensively). `resetsAt` is the server-reported ISO-8601 timestamp
/// parsed into a local DateTime or null when missing / unparseable.
@immutable
class RateWindow {
  final double usedPercentage;
  final DateTime? resetsAt;

  const RateWindow({required this.usedPercentage, this.resetsAt});

  static RateWindow? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final pctRaw = raw['used_percentage'];
    double? pct;
    if (pctRaw is num) {
      pct = pctRaw.toDouble();
    } else if (pctRaw is String) {
      pct = double.tryParse(pctRaw);
    }
    if (pct == null) return null;
    DateTime? resetsAt;
    final resetsRaw = raw['resets_at'];
    if (resetsRaw is String && resetsRaw.isNotEmpty) {
      resetsAt = DateTime.tryParse(resetsRaw);
    }
    return RateWindow(usedPercentage: pct, resetsAt: resetsAt);
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RateWindow &&
          other.usedPercentage == usedPercentage &&
          other.resetsAt == resetsAt;

  @override
  int get hashCode => Object.hash(usedPercentage, resetsAt);

  @override
  String toString() =>
      'RateWindow(usedPercentage: $usedPercentage, resetsAt: $resetsAt)';
}

/// Parsed Claude Code rate-limits snapshot (5-hour + 7-day).
@immutable
class RateLimits {
  final RateWindow? fiveHour;
  final RateWindow? sevenDay;

  const RateLimits({this.fiveHour, this.sevenDay});

  /// Parse the `statusline.rate_limits` JSON blob produced by the server.
  ///
  /// Returns null when [raw] is null, empty, not valid JSON, or not an
  /// object. Sub-objects are tolerated when missing.
  static RateLimits? fromJsonString(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    Object? decoded;
    try {
      decoded = json.decode(raw);
    } catch (_) {
      return null;
    }
    if (decoded is! Map) return null;
    final fh = RateWindow.fromJson(decoded['five_hour']);
    final sd = RateWindow.fromJson(decoded['seven_day']);
    if (fh == null && sd == null) return null;
    return RateLimits(fiveHour: fh, sevenDay: sd);
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RateLimits &&
          other.fiveHour == fiveHour &&
          other.sevenDay == sevenDay;

  @override
  int get hashCode => Object.hash(fiveHour, sevenDay);

  @override
  String toString() =>
      'RateLimits(fiveHour: $fiveHour, sevenDay: $sevenDay)';
}
