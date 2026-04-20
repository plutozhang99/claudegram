import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;

import '../models/session.dart';
import '../providers/harbor_providers.dart';
import '../theme/mistral_theme.dart';
import '../widgets/section_label.dart';
import 'detail/chat_pane.dart';
import 'detail/metadata_collapsed.dart';
import 'detail/metadata_pane.dart';

const double _bpWide = 960;
const double _metadataPaneWidth = 360;

/// Project basename + short session id suffix — `"harbor [abc12345]"`.
String sessionShortLabel(Session s) {
  final String? src = s.projectDir ?? s.cwd;
  String name = '\u2014';
  if (src != null && src.isNotEmpty) {
    final String base = p.basename(src);
    if (base.isNotEmpty) name = base;
  }
  final String suffix = s.sessionId.length >= 8
      ? s.sessionId.substring(0, 8)
      : s.sessionId;
  return '$name [$suffix]';
}

class SessionDetailScreen extends ConsumerWidget {
  const SessionDetailScreen({required this.sessionId, super.key});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<Session> async = ref.watch(sessionDetailProvider(sessionId));
    return Scaffold(
      appBar: AppBar(
        title: SectionLabel(label: _titleFor(async, sessionId)),
      ),
      body: async.when(
        loading: () => const _LoadingBody(),
        error: (Object err, StackTrace stack) => _ErrorBody(
          error: err,
          sessionId: sessionId,
          onRetry: () => ref.invalidate(sessionDetailProvider(sessionId)),
        ),
        data: (Session session) => _DetailBody(session: session),
      ),
    );
  }

  static String _titleFor(AsyncValue<Session> async, String sessionId) {
    return async.maybeWhen(
      data: sessionShortLabel,
      orElse: () {
        final String suffix = sessionId.length >= 8
            ? sessionId.substring(0, 8)
            : sessionId;
        return 'SESSION [$suffix]';
      },
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final bool wide = constraints.maxWidth >= _bpWide;
        if (wide) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                flex: 3,
                child: ChatPane(sessionId: session.sessionId, session: session),
              ),
              const SizedBox(
                width: 1,
                child: ColoredBox(color: kInputBorder),
              ),
              SizedBox(
                width: _metadataPaneWidth,
                child: MetadataPane(session: session),
              ),
            ],
          );
        }
        // Mobile: top info card above the chat. Chosen over "scrollable
        // header" because it keeps the chat scroll state independent from
        // the metadata view, which helps when the message list is long.
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            MetadataCollapsed(session: session),
            const SizedBox(
              height: 1,
              child: ColoredBox(color: kInputBorder),
            ),
            Expanded(
              child: ChatPane(sessionId: session.sessionId, session: session),
            ),
          ],
        );
      },
    );
  }
}

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();

  @override
  Widget build(BuildContext context) {
    // Two-row skeleton that hints at the real detail layout: a top
    // metadata strip (mirrors the collapsed summary / pane header) and
    // two alternating message-bubble shapes below. Static — no shimmer.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(color: kCream, height: 96),
        const SizedBox(
          height: 1,
          child: ColoredBox(color: kInputBorder),
        ),
        const Expanded(
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 16, vertical: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Align(
                  alignment: Alignment.centerLeft,
                  child: _SkeletonBubble(
                    width: 240,
                    color: kWarmIvory,
                  ),
                ),
                SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: _SkeletonBubble(
                    width: 200,
                    color: kCream,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _SkeletonBubble extends StatelessWidget {
  const _SkeletonBubble({required this.width, required this.color});

  final double width;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: color,
      width: width,
      height: 48,
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({
    required this.error,
    required this.sessionId,
    required this.onRetry,
  });

  final Object error;
  final String sessionId;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Container(
          decoration: const BoxDecoration(
            color: kWarmIvory,
            boxShadow: mistralGoldenShadows,
          ),
          padding: const EdgeInsets.all(32),
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text('UNABLE TO REACH HARBOR', style: t.headlineLarge),
              const SizedBox(height: 12),
              Text(
                'session_id: $sessionId',
                style: const TextStyle(
                  fontFamily: 'Courier',
                  fontSize: 14,
                  height: 1.43,
                  fontWeight: FontWeight.w400,
                  color: kMistralBlack,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                error.toString(),
                style: t.bodyLarge?.copyWith(
                  color: kMistralBlack.withValues(alpha: 0.75),
                ),
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: onRetry,
                child: const Text('RETRY'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
