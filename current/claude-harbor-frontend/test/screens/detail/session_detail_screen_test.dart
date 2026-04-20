import 'dart:async';

import 'package:claude_harbor_frontend/models/message.dart';
import 'package:claude_harbor_frontend/models/session.dart';
import 'package:claude_harbor_frontend/providers/harbor_providers.dart';
import 'package:claude_harbor_frontend/screens/detail/chat_pane.dart';
import 'package:claude_harbor_frontend/screens/detail/compose_box.dart';
import 'package:claude_harbor_frontend/screens/detail/metadata_collapsed.dart';
import 'package:claude_harbor_frontend/screens/detail/metadata_pane.dart';
import 'package:claude_harbor_frontend/screens/session_detail_screen.dart';
import 'package:claude_harbor_frontend/theme/mistral_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Session _mk({
  String sessionId = 'abcdef1234',
  String status = 'active',
  String projectDir = '/work/demo',
}) {
  return Session(
    sessionId: sessionId,
    cwd: '/cwd/demo',
    pid: 1234,
    projectDir: projectDir,
    accountHint: null,
    startedAt: 1,
    endedAt: null,
    endedReason: null,
    latestModel: 'claude-sonnet-4-6',
    latestModelDisplay: 'Sonnet 4.6',
    latestVersion: '1.0.0',
    latestPermissionMode: 'default',
    latestCtxPct: 30,
    latestCtxWindowSize: 200000,
    latestLimitsJson: null,
    latestCostUsd: 2.50,
    latestStatuslineAt: null,
    status: status,
  );
}

Widget _host({
  required Widget child,
  required AsyncValue<Session> sessionAsync,
  List<Message> messages = const <Message>[],
}) {
  return ProviderScope(
    overrides: <Override>[
      sessionDetailProvider.overrideWith((ref, id) async {
        return sessionAsync.when(
          data: (s) => s,
          loading: () => Completer<Session>().future,
          error: (e, st) => Future<Session>.error(e, st),
        );
      }),
      messagesProvider.overrideWith(
        (ref, id) => Stream<List<Message>>.value(messages),
      ),
    ],
    child: MaterialApp(
      theme: mistralLightTheme,
      home: child,
    ),
  );
}

void main() {
  testWidgets('loading → shows no error/body yet', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sessionDetailProvider.overrideWith(
            (ref, id) => Completer<Session>().future,
          ),
          messagesProvider.overrideWith(
            (ref, id) => const Stream<List<Message>>.empty(),
          ),
        ],
        child: const MaterialApp(
          home: SessionDetailScreen(sessionId: 'abcdef12'),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(SessionDetailScreen), findsOneWidget);
    expect(find.byType(ChatPane), findsNothing);
    // AppBar title placeholder uses the short id — SectionLabel uppercases.
    expect(find.textContaining('ABCDEF12'), findsOneWidget);
  });

  testWidgets('error → UNABLE TO REACH HARBOR with session_id',
      (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sessionDetailProvider.overrideWith(
            (ref, id) => Future<Session>.error(StateError('boom')),
          ),
          messagesProvider.overrideWith(
            (ref, id) => const Stream<List<Message>>.empty(),
          ),
        ],
        child: const MaterialApp(
          home: SessionDetailScreen(sessionId: 'abcdef12'),
        ),
      ),
    );
    await tester.pump(); // resolve future
    expect(find.text('UNABLE TO REACH HARBOR'), findsOneWidget);
    expect(find.textContaining('session_id: abcdef12'), findsOneWidget);
    expect(find.text('RETRY'), findsOneWidget);
  });

  testWidgets('wide viewport → two-pane layout with ChatPane + MetadataPane',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_host(
      child: const SessionDetailScreen(sessionId: 'abcdef1234'),
      sessionAsync: AsyncValue<Session>.data(_mk()),
    ));
    await tester.pump();
    expect(find.byType(ChatPane), findsOneWidget);
    expect(find.byType(MetadataPane), findsOneWidget);
    expect(find.byType(MetadataCollapsed), findsNothing);
    expect(find.text('PROJECT'), findsOneWidget);
    expect(find.text('MODEL'), findsOneWidget);
    expect(find.text('CONTEXT'), findsOneWidget);
    expect(find.text('LIMITS'), findsOneWidget);
    expect(find.text('COST'), findsOneWidget);
    expect(find.text('STATUS'), findsOneWidget);
  });

  testWidgets('narrow viewport → stacked layout with MetadataCollapsed',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_host(
      child: const SessionDetailScreen(sessionId: 'abcdef1234'),
      sessionAsync: AsyncValue<Session>.data(_mk()),
    ));
    await tester.pump();
    expect(find.byType(ChatPane), findsOneWidget);
    expect(find.byType(MetadataCollapsed), findsOneWidget);
    expect(find.byType(MetadataPane), findsNothing);
  });

  testWidgets('active session → SEND button present (enabled when typed)',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_host(
      child: const SessionDetailScreen(sessionId: 'abcdef1234'),
      sessionAsync: AsyncValue<Session>.data(_mk(status: 'active')),
    ));
    await tester.pump();
    expect(find.byType(ComposeBox), findsOneWidget);
    expect(find.text('SEND'), findsOneWidget);
  });

  testWidgets('ended session → SEND button still present but disabled',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_host(
      child: const SessionDetailScreen(sessionId: 'abcdef1234'),
      sessionAsync: AsyncValue<Session>.data(_mk(status: 'ended')),
    ));
    await tester.pump();
    expect(find.text('SEND'), findsOneWidget);
    final ElevatedButton btn =
        tester.widget(find.byType(ElevatedButton).last) as ElevatedButton;
    expect(btn.onPressed, isNull);
  });
}
