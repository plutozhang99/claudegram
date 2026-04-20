import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/session.dart';
import '../providers/harbor_providers.dart';
import '../theme/mistral_theme.dart';
import '../widgets/section_label.dart';
import 'session_detail_screen.dart';
import 'sessions/session_tile.dart';
import 'sessions/skeleton_tile.dart';

const double _bpSmall = 600;
const double _bpWide = 960;
const double _maxContentWidth = 960;

Route<void> _sessionDetailRoute(String sessionId) {
  return MaterialPageRoute<void>(
    builder: (_) => SessionDetailScreen(sessionId: sessionId),
  );
}

class SessionListScreen extends ConsumerWidget {
  const SessionListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<Session>> async = ref.watch(sessionListProvider);
    return Scaffold(
      appBar: AppBar(title: const SectionLabel(label: 'HARBOR')),
      body: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final double horizontalPadding = _paddingFor(constraints.maxWidth);
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: _maxContentWidth),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: horizontalPadding),
                child: async.when(
                  loading: () => const _LoadingBody(),
                  error: (Object err, StackTrace stack) => _ErrorPanel(
                    error: err,
                    onRetry: () => ref.invalidate(sessionListProvider),
                  ),
                  data: (List<Session> list) {
                    if (list.isEmpty) {
                      return const _EmptyState();
                    }
                    return _SessionListBody(
                      sessions: list,
                      onRefresh: () async {
                        ref.invalidate(sessionListProvider);
                        // Await the next value (or error) — the indicator
                        // closes when real data arrives, not a fixed timeout.
                        await ref.read(sessionListProvider.future);
                      },
                    );
                  },
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  static double _paddingFor(double w) {
    if (w >= _bpWide) return 64;
    if (w >= _bpSmall) return 32;
    return 16;
  }
}

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: const <Widget>[
        SkeletonList(count: 3),
      ],
    );
  }
}

class _SessionListBody extends StatelessWidget {
  const _SessionListBody({
    required this.sessions,
    required this.onRefresh,
  });

  final List<Session> sessions;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      color: kMistralOrange,
      backgroundColor: kWarmIvory,
      onRefresh: onRefresh,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: sessions.length,
        separatorBuilder: (_, __) => const SizedBox.shrink(),
        itemBuilder: (BuildContext context, int i) {
          final Session s = sessions[i];
          return SessionTile(
            session: s,
            onTap: () {
              Navigator.of(context).push(_sessionDetailRoute(s.sessionId));
            },
          );
        },
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 64),
        child: Container(
          decoration: const BoxDecoration(
            color: kWarmIvory,
            boxShadow: mistralGoldenShadows,
          ),
          padding: const EdgeInsets.all(32),
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text('NO ACTIVE SESSIONS', style: t.headlineLarge),
              const SizedBox(height: 12),
              Text.rich(
                TextSpan(
                  style: t.bodyLarge?.copyWith(
                    color: kMistralBlack.withValues(alpha: 0.75),
                  ),
                  children: const <InlineSpan>[
                    TextSpan(text: 'Run '),
                    TextSpan(
                      text: 'claude-harbor start',
                      style: TextStyle(
                        fontFamily: 'Courier',
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                    TextSpan(text: ' in a project to see it here.'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 64),
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
