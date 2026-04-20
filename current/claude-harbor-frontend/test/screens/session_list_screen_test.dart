import 'dart:async';

import 'package:claude_harbor_frontend/models/message.dart';
import 'package:claude_harbor_frontend/models/session.dart';
import 'package:claude_harbor_frontend/providers/harbor_providers.dart';
import 'package:claude_harbor_frontend/screens/session_detail_screen.dart';
import 'package:claude_harbor_frontend/screens/session_list_screen.dart';
import 'package:claude_harbor_frontend/screens/sessions/skeleton_tile.dart';
import 'package:claude_harbor_frontend/screens/sessions/session_tile.dart';
import 'package:claude_harbor_frontend/theme/mistral_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Session _mk({
  String sessionId = 'abcdef1234',
  String projectDir = '/Users/pluto/projects/demo',
  String status = 'active',
  double? ctxPct = 30,
  int? ctxWindow = 200000,
  String? modelDisplay = 'Sonnet 4.6',
}) {
  return Session(
    sessionId: sessionId,
    cwd: null,
    pid: null,
    projectDir: projectDir,
    accountHint: null,
    startedAt: 1,
    endedAt: null,
    endedReason: null,
    latestModel: 'claude-sonnet-4-6',
    latestModelDisplay: modelDisplay,
    latestVersion: null,
    latestPermissionMode: null,
    latestCtxPct: ctxPct,
    latestCtxWindowSize: ctxWindow,
    latestLimitsJson: null,
    latestCostUsd: 1.23,
    latestStatuslineAt: null,
    status: status,
  );
}

Widget _host({required Stream<List<Session>> Function() streamBuilder}) {
  return ProviderScope(
    overrides: <Override>[
      sessionListProvider.overrideWith((ref) => streamBuilder()),
    ],
    child: const MaterialApp(
      home: SessionListScreen(),
    ),
  );
}

Widget _hostTheme({required Stream<List<Session>> Function() streamBuilder}) {
  return ProviderScope(
    overrides: <Override>[
      sessionListProvider.overrideWith((ref) => streamBuilder()),
    ],
    child: MaterialApp(
      theme: mistralLightTheme,
      home: const SessionListScreen(),
    ),
  );
}

void main() {
  testWidgets('loading → 3 skeleton tiles', (tester) async {
    await tester.pumpWidget(_host(
      streamBuilder: () => const Stream<List<Session>>.empty()
          .asBroadcastStream(), // never emits
    ));
    await tester.pump();
    expect(find.byType(SkeletonTile), findsNWidgets(3));
  });

  testWidgets('error → UNABLE TO REACH HARBOR + RETRY recovers to empty',
      (tester) async {
    int builds = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sessionListProvider.overrideWith((ref) {
            final int call = builds++;
            if (call == 0) {
              final StreamController<List<Session>> c =
                  StreamController<List<Session>>();
              c.addError(StateError('network down'));
              return c.stream;
            }
            return Stream<List<Session>>.value(<Session>[]);
          }),
        ],
        child: const MaterialApp(home: SessionListScreen()),
      ),
    );
    await tester.pump();
    expect(find.text('UNABLE TO REACH HARBOR'), findsOneWidget);
    expect(find.text('RETRY'), findsOneWidget);
    expect(builds, equals(1));

    await tester.tap(find.text('RETRY'));
    await tester.pumpAndSettle();
    // Invalidation recreates the stream; second build returns empty list.
    expect(builds, greaterThanOrEqualTo(2));
    expect(find.text('NO ACTIVE SESSIONS'), findsOneWidget);
  });

  testWidgets('data:[] → empty state with claude-harbor start hint',
      (tester) async {
    await tester.pumpWidget(_host(
      streamBuilder: () => Stream<List<Session>>.value(<Session>[]),
    ));
    await tester.pump();
    expect(find.text('NO ACTIVE SESSIONS'), findsOneWidget);
    expect(find.textContaining('claude-harbor start'), findsOneWidget);
  });

  testWidgets('data:[s] → renders SessionTile with project basename',
      (tester) async {
    final Session s = _mk(projectDir: '/work/harbor-frontend');
    await tester.pumpWidget(_hostTheme(
      streamBuilder: () => Stream<List<Session>>.value(<Session>[s]),
    ));
    await tester.pump();
    expect(find.byType(SessionTile), findsOneWidget);
    expect(find.text('harbor-frontend'), findsOneWidget);
    expect(find.text('Sonnet 4.6'), findsOneWidget);
    // Ctx bar label renders with % and ctx tokens.
    expect(find.textContaining('30%'), findsOneWidget);
  });

  testWidgets('tap tile pushes SessionDetailScreen', (tester) async {
    final Session s = _mk(
      sessionId: 'uniqueid99',
      projectDir: '/work/demo',
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sessionListProvider.overrideWith(
            (ref) => Stream<List<Session>>.value(<Session>[s]),
          ),
          sessionDetailProvider.overrideWith((ref, id) async => s),
          messagesProvider.overrideWith(
            (ref, id) => Stream<List<Message>>.value(const <Message>[]),
          ),
        ],
        child: MaterialApp(
          theme: mistralLightTheme,
          home: const SessionListScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byType(SessionTile));
    await tester.pumpAndSettle();
    expect(find.byType(SessionDetailScreen), findsOneWidget);
    // AppBar title contains the short session-id suffix — uppercased by SectionLabel.
    expect(find.textContaining('UNIQUEID'), findsOneWidget);
  });
}
