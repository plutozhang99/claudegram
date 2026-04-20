import 'package:meta/meta.dart';

/// Direction of a message row, as persisted server-side.
///
/// `inbound` = user → Claude (via channel), `outbound` = Claude → user
/// (via reply tool). Server string values are the canonical lowercase form.
enum MessageDirection {
  inbound,
  outbound;

  static MessageDirection parse(String raw) {
    switch (raw) {
      case 'inbound':
        return MessageDirection.inbound;
      case 'outbound':
        return MessageDirection.outbound;
      default:
        throw ArgumentError('unknown MessageDirection: $raw');
    }
  }

  String get wireValue => name;
}

/// Flutter-side mirror of the server `MessageRow` projection.
@immutable
class Message {
  final int id;
  final String sessionId;
  final MessageDirection direction;
  final String content;
  final String? metaJson;
  final int createdAt;

  const Message({
    required this.id,
    required this.sessionId,
    required this.direction,
    required this.content,
    required this.metaJson,
    required this.createdAt,
  });

  factory Message.fromJson(Map<String, dynamic> json) {
    final rawId = json['id'];
    if (rawId is! num) {
      throw const FormatException('Message.id missing or not a num');
    }
    final rawSessionId = json['session_id'];
    if (rawSessionId is! String) {
      throw const FormatException('Message.session_id missing or not a String');
    }
    final rawDirection = json['direction'];
    if (rawDirection is! String) {
      throw const FormatException('Message.direction missing or not a String');
    }
    final rawContent = json['content'];
    if (rawContent is! String) {
      throw const FormatException('Message.content missing or not a String');
    }
    final rawCreatedAt = json['created_at'];
    if (rawCreatedAt is! num) {
      throw const FormatException('Message.created_at missing or not a num');
    }
    return Message(
      id: rawId.toInt(),
      sessionId: rawSessionId,
      direction: MessageDirection.parse(rawDirection),
      content: rawContent,
      metaJson: json['meta_json'] is String ? json['meta_json'] as String : null,
      createdAt: rawCreatedAt.toInt(),
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'session_id': sessionId,
        'direction': direction.wireValue,
        'content': content,
        'meta_json': metaJson,
        'created_at': createdAt,
      };

  Message copyWith({
    int? id,
    String? sessionId,
    MessageDirection? direction,
    String? content,
    String? Function()? metaJson,
    int? createdAt,
  }) {
    return Message(
      id: id ?? this.id,
      sessionId: sessionId ?? this.sessionId,
      direction: direction ?? this.direction,
      content: content ?? this.content,
      metaJson: metaJson != null ? metaJson() : this.metaJson,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Message &&
        other.id == id &&
        other.sessionId == sessionId &&
        other.direction == direction &&
        other.content == content &&
        other.metaJson == metaJson &&
        other.createdAt == createdAt;
  }

  @override
  int get hashCode =>
      Object.hash(id, sessionId, direction, content, metaJson, createdAt);

  @override
  String toString() =>
      'Message(id: $id, session: $sessionId, direction: $direction)';
}
