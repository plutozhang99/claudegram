import '../models/message.dart';
import '../services/harbor_api_client.dart';
import '../services/harbor_live_service.dart';

/// Repository for chat history + live inbound message feed.
class MessageRepository {
  final HarborApiClient api;
  final HarborLiveService live;

  MessageRepository({required this.api, required this.live});

  Future<MessagePage> fetchPage(
    String sessionId, {
    int? before,
    int? limit,
  }) {
    return api.listMessages(sessionId, before: before, limit: limit);
  }

  /// Stream of newly-created messages for [sessionId].
  Stream<Message> watchInbox(String sessionId) {
    return live.events
        .where((e) => e is MessageCreated && e.sessionId == sessionId)
        .map((e) => (e as MessageCreated).message);
  }
}
