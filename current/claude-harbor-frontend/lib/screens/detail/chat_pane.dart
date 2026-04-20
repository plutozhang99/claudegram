import 'dart:developer' as developer;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/message.dart';
import '../../models/session.dart';
import '../../providers/harbor_providers.dart';
import '../../theme/mistral_theme.dart';
import 'compose_box.dart';

// A >60s gap between consecutive messages inserts a timestamp label.
const Duration kTimestampGroupGap = Duration(seconds: 60);

// Distance from bottom under which we consider the user "at bottom" and
// eligible for auto-scroll on new-message arrivals. Above this, we leave
// the scroll position alone so scroll-up-to-read-history isn't hijacked.
const double kAutoScrollThreshold = 120;

class ChatPane extends ConsumerStatefulWidget {
  const ChatPane({required this.sessionId, required this.session, super.key});

  final String sessionId;
  final Session session;

  @override
  ConsumerState<ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends ConsumerState<ChatPane> {
  final ScrollController _controller = ScrollController();
  int _lastCount = 0;
  int? _lastHeadId;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _scheduleAutoScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_controller.hasClients) return;
      // With `reverse: true` the visual "bottom" is position 0.0.
      _controller.animateTo(
        0,
        duration: const Duration(milliseconds: 140),
        curve: Curves.easeOut,
      );
    });
  }

  bool _userNearBottom() {
    if (!_controller.hasClients) return true;
    // reverse:true → extentBefore is distance from bottom of list.
    return _controller.position.extentBefore < kAutoScrollThreshold;
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<List<Message>> async =
        ref.watch(messagesProvider(widget.sessionId));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(child: _ChatList(
          async: async,
          controller: _controller,
          onMessagesChanged: _onMessagesChanged,
        )),
        const SizedBox(
          height: 1,
          child: ColoredBox(color: kInputBorder),
        ),
        ComposeBox(sessionId: widget.sessionId, session: widget.session),
      ],
    );
  }

  void _onMessagesChanged(List<Message> list) {
    // Only run when the message list actually changed since last emission.
    final int? newHeadId = list.isEmpty ? null : list.last.id;
    final bool sameAsLast = list.length == _lastCount &&
        (list.isEmpty || newHeadId == _lastHeadId);
    if (sameAsLast) return;
    final int prevCount = _lastCount;
    _lastCount = list.length;
    _lastHeadId = newHeadId;
    if (list.length > prevCount && _userNearBottom()) {
      _scheduleAutoScroll();
    }
  }
}

class _ChatList extends StatefulWidget {
  const _ChatList({
    required this.async,
    required this.controller,
    required this.onMessagesChanged,
  });

  final AsyncValue<List<Message>> async;
  final ScrollController controller;
  final ValueChanged<List<Message>> onMessagesChanged;

  @override
  State<_ChatList> createState() => _ChatListState();
}

class _ChatListState extends State<_ChatList> {
  int _lastNotifiedCount = 0;
  int? _lastNotifiedHeadId;

  @override
  Widget build(BuildContext context) {
    return widget.async.when(
      loading: () => const _ChatLoading(),
      error: (Object e, StackTrace _) => _ChatError(error: e),
      data: (List<Message> messages) {
        // Only schedule a post-frame notify if the list actually changed
        // (identity check: length + newest id). Prevents a callback firing
        // on every rebuild caused by unrelated widget state churn.
        final int? headId = messages.isEmpty ? null : messages.last.id;
        final bool changed = messages.length != _lastNotifiedCount ||
            headId != _lastNotifiedHeadId;
        if (changed) {
          _lastNotifiedCount = messages.length;
          _lastNotifiedHeadId = headId;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            widget.onMessagesChanged(messages);
          });
        }
        if (messages.isEmpty) {
          return const _ChatEmpty();
        }
        return _MessageList(messages: messages, controller: widget.controller);
      },
    );
  }
}

class _MessageList extends StatelessWidget {
  const _MessageList({required this.messages, required this.controller});

  final List<Message> messages;
  final ScrollController controller;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double paneWidth = constraints.maxWidth;
        // Using reverse:true so the newest (last) message pins to the
        // visual bottom; index 0 is the newest message.
        final int count = messages.length;
        return ListView.builder(
          controller: controller,
          reverse: true,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          itemCount: count,
          itemBuilder: (BuildContext context, int i) {
            // reverse:true → item at index i is messages[count-1-i].
            final int msgIndex = count - 1 - i;
            final Message m = messages[msgIndex];
            final bool showTimestamp = _shouldShowTimestampLabel(
              messages,
              msgIndex,
            );
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (showTimestamp)
                  _TimestampLabel(millis: m.createdAt),
                _MessageBubble(message: m, paneWidth: paneWidth),
                const SizedBox(height: 8),
              ],
            );
          },
        );
      },
    );
  }

  static bool _shouldShowTimestampLabel(List<Message> list, int index) {
    // With reverse:true, the label sits ABOVE the bubble. Only show it when
    // a >kTimestampGroupGap gap exists vs the previous chronological msg.
    // No "first message always shows" rule — that placed the label at the
    // visual bottom in a reversed list.
    if (index == 0) return false;
    final Message prev = list[index - 1];
    final Message cur = list[index];
    final int deltaMs = cur.createdAt - prev.createdAt;
    return deltaMs > kTimestampGroupGap.inMilliseconds;
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.paneWidth});

  final Message message;
  final double paneWidth;

  @override
  Widget build(BuildContext context) {
    final bool isInbound = message.direction == MessageDirection.inbound;
    final double maxBubbleWidth = paneWidth * 0.8;
    final Alignment align =
        isInbound ? Alignment.centerRight : Alignment.centerLeft;
    final BoxDecoration decoration = isInbound
        ? const BoxDecoration(color: kCream)
        : const BoxDecoration(
            color: kWarmIvory,
            border: Border(
              left: BorderSide(color: kMistralOrange, width: 2),
            ),
          );
    return Align(
      alignment: align,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxBubbleWidth),
        child: Container(
          decoration: decoration,
          padding: const EdgeInsets.all(12),
          child: SelectableText(
            message.content,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      ),
    );
  }
}

class _TimestampLabel extends StatelessWidget {
  const _TimestampLabel({required this.millis});

  final int millis;

  @override
  Widget build(BuildContext context) {
    final TextStyle? base = Theme.of(context).textTheme.bodySmall;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Center(
        child: Text(
          formatTimestamp(millis),
          style: base?.copyWith(
            fontSize: 14,
            color: kMistralBlack.withValues(alpha: 0.55),
          ),
        ),
      ),
    );
  }
}

/// Formats a millis-since-epoch into a chat timestamp label.
///
/// Same-day as "now" → `HH:mm` 24h. Otherwise → `yyyy-MM-dd HH:mm`.
/// Hand-rolled; no `intl` dep allowed.
String formatTimestamp(int millis, {DateTime? now}) {
  final DateTime at = DateTime.fromMillisecondsSinceEpoch(millis);
  final DateTime effectiveNow = now ?? DateTime.now();
  final bool sameDay = at.year == effectiveNow.year &&
      at.month == effectiveNow.month &&
      at.day == effectiveNow.day;
  final String hh = at.hour.toString().padLeft(2, '0');
  final String mm = at.minute.toString().padLeft(2, '0');
  if (sameDay) return '$hh:$mm';
  final String yyyy = at.year.toString().padLeft(4, '0');
  final String mon = at.month.toString().padLeft(2, '0');
  final String dd = at.day.toString().padLeft(2, '0');
  return '$yyyy-$mon-$dd $hh:$mm';
}

class _ChatLoading extends StatelessWidget {
  const _ChatLoading();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Container(color: kCream, height: 48),
          const SizedBox(height: 12),
          Container(color: kCream, height: 72),
          const SizedBox(height: 12),
          Container(color: kCream, height: 40),
        ],
      ),
    );
  }
}

class _ChatError extends StatelessWidget {
  const _ChatError({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    // Log full error for debugging; UI shows a static, leak-free message.
    developer.log(
      'chat load failed',
      name: 'harbor.chat',
      error: error,
    );
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'Unable to load messages.',
          style: t.bodyLarge?.copyWith(
            color: kMistralBlack.withValues(alpha: 0.7),
          ),
        ),
      ),
    );
  }
}

class _ChatEmpty extends StatelessWidget {
  const _ChatEmpty();

  @override
  Widget build(BuildContext context) {
    final TextStyle? base = Theme.of(context).textTheme.bodySmall;
    return Center(
      child: Text(
        'No messages yet.',
        style: base?.copyWith(
          fontSize: 14,
          color: kMistralBlack.withValues(alpha: 0.55),
        ),
      ),
    );
  }
}
