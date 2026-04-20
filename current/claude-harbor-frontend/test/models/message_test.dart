import 'package:claude_harbor_frontend/models/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('MessageDirection.parse maps canonical values', () {
    expect(MessageDirection.parse('inbound'), MessageDirection.inbound);
    expect(MessageDirection.parse('outbound'), MessageDirection.outbound);
  });

  test('MessageDirection.parse throws on unknown', () {
    expect(() => MessageDirection.parse('sideways'), throwsArgumentError);
  });

  test('Message.fromJson parses canonical row', () {
    final m = Message.fromJson(const <String, dynamic>{
      'id': 7,
      'session_id': 'sess-1',
      'direction': 'inbound',
      'content': 'hi',
      'meta_json': null,
      'created_at': 1700000000000,
    });
    expect(m.id, 7);
    expect(m.direction, MessageDirection.inbound);
    expect(m.content, 'hi');
    expect(m.createdAt, 1700000000000);
  });

  test('copyWith clears nullable metaJson via closure', () {
    final m = Message.fromJson(const <String, dynamic>{
      'id': 1,
      'session_id': 's',
      'direction': 'outbound',
      'content': 'c',
      'meta_json': '{"k":1}',
      'created_at': 0,
    });
    final m2 = m.copyWith(metaJson: () => null);
    expect(m2.metaJson, null);
    expect(m.metaJson, isNotNull);
  });

  test('equality and hashCode', () {
    final a = Message.fromJson(const <String, dynamic>{
      'id': 1,
      'session_id': 's',
      'direction': 'outbound',
      'content': 'c',
      'meta_json': null,
      'created_at': 0,
    });
    final b = Message.fromJson(const <String, dynamic>{
      'id': 1,
      'session_id': 's',
      'direction': 'outbound',
      'content': 'c',
      'meta_json': null,
      'created_at': 0,
    });
    expect(a, b);
    expect(a.hashCode, b.hashCode);
  });
}
