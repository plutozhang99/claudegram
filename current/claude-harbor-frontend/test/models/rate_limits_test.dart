import 'package:claude_harbor_frontend/models/rate_limits.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('fromJsonString parses both windows', () {
    const raw =
        '{"five_hour":{"used_percentage":25.0,"resets_at":"2026-04-20T12:00:00Z"},'
        '"seven_day":{"used_percentage":12.5}}';
    final rl = RateLimits.fromJsonString(raw);
    expect(rl, isNotNull);
    expect(rl!.fiveHour!.usedPercentage, 25.0);
    expect(rl.fiveHour!.resetsAt, DateTime.parse('2026-04-20T12:00:00Z'));
    expect(rl.sevenDay!.usedPercentage, 12.5);
    expect(rl.sevenDay!.resetsAt, null);
  });

  test('fromJsonString tolerates missing sub-objects', () {
    const raw = '{"five_hour":{"used_percentage":10}}';
    final rl = RateLimits.fromJsonString(raw);
    expect(rl, isNotNull);
    expect(rl!.fiveHour!.usedPercentage, 10);
    expect(rl.sevenDay, null);
  });

  test('fromJsonString returns null on null/empty input', () {
    expect(RateLimits.fromJsonString(null), null);
    expect(RateLimits.fromJsonString(''), null);
  });

  test('fromJsonString returns null on invalid JSON', () {
    expect(RateLimits.fromJsonString('{not-json'), null);
  });

  test('fromJsonString returns null when both windows are absent/invalid', () {
    expect(RateLimits.fromJsonString('{}'), null);
    expect(RateLimits.fromJsonString('{"five_hour":"nope"}'), null);
  });

  test('fromJsonString tolerates numeric string used_percentage', () {
    const raw = '{"five_hour":{"used_percentage":"33.3"}}';
    final rl = RateLimits.fromJsonString(raw);
    expect(rl!.fiveHour!.usedPercentage, 33.3);
  });
}
