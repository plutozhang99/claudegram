import 'package:claude_harbor_frontend/models/session.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const fullJson = <String, dynamic>{
    'session_id': 'sess-123',
    'cwd': '/tmp/repo',
    'pid': 42,
    'project_dir': '/tmp/repo',
    'account_hint': 'user@example.com',
    'started_at': 1700000000000,
    'ended_at': null,
    'ended_reason': null,
    'latest_model': 'claude-opus-4-7',
    'latest_model_display': 'Opus 4.7',
    'latest_version': '1.2.3',
    'latest_permission_mode': 'default',
    'latest_ctx_pct': 42.5,
    'latest_ctx_window_size': 200000,
    'latest_limits_json':
        '{"five_hour":{"used_percentage":12.5,"resets_at":"2026-04-20T12:00:00Z"}}',
    'latest_cost_usd': 0.42,
    'latest_statusline_at': 1700000001000,
    'status': 'active',
  };

  test('Session.fromJson parses all fields', () {
    final s = Session.fromJson(fullJson);
    expect(s.sessionId, 'sess-123');
    expect(s.cwd, '/tmp/repo');
    expect(s.pid, 42);
    expect(s.projectDir, '/tmp/repo');
    expect(s.accountHint, 'user@example.com');
    expect(s.startedAt, 1700000000000);
    expect(s.endedAt, null);
    expect(s.latestModel, 'claude-opus-4-7');
    expect(s.latestCtxPct, 42.5);
    expect(s.latestCostUsd, 0.42);
    expect(s.latestStatuslineAt, 1700000001000);
    expect(s.status, 'active');
  });

  test('Session.fromJson tolerates nulls in optional fields', () {
    final s = Session.fromJson(const <String, dynamic>{
      'session_id': 'sess-1',
      'started_at': 1,
      'status': 'active',
    });
    expect(s.cwd, null);
    expect(s.pid, null);
    expect(s.latestCtxPct, null);
  });

  test('Session.toJson round-trips (fromJson ∘ toJson == identity)', () {
    final a = Session.fromJson(fullJson);
    final b = Session.fromJson(a.toJson());
    expect(a, b);
    expect(a.hashCode, b.hashCode);
  });

  test('copyWith replaces only the supplied fields', () {
    final a = Session.fromJson(fullJson);
    final b = a.copyWith(status: 'ended', endedAt: () => 123);
    expect(b.status, 'ended');
    expect(b.endedAt, 123);
    expect(b.sessionId, a.sessionId);
    expect(b.latestModel, a.latestModel);
  });

  test('copyWith of nullable field with closure returning null clears it', () {
    final a = Session.fromJson(fullJson);
    final b = a.copyWith(latestModel: () => null);
    expect(b.latestModel, null);
    expect(a.latestModel, isNotNull); // a unchanged
  });

  test('rateLimits getter parses latestLimitsJson', () {
    final s = Session.fromJson(fullJson);
    final rl = s.rateLimits;
    expect(rl, isNotNull);
    expect(rl!.fiveHour!.usedPercentage, 12.5);
  });

  test('equality by value', () {
    final a = Session.fromJson(fullJson);
    final b = Session.fromJson(fullJson);
    expect(a == b, isTrue);
  });
}
