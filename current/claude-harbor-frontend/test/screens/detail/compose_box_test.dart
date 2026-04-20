import 'package:claude_harbor_frontend/models/session.dart';
import 'package:claude_harbor_frontend/providers/harbor_providers.dart';
import 'package:claude_harbor_frontend/screens/detail/compose_box.dart';
import 'package:claude_harbor_frontend/services/harbor_api_client.dart';
import 'package:claude_harbor_frontend/theme/mistral_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements HarborApiClient {}

Session _session({String status = 'active'}) {
  return Session(
    sessionId: 'sess-1',
    cwd: null,
    pid: null,
    projectDir: '/work/demo',
    accountHint: null,
    startedAt: 1,
    endedAt: null,
    endedReason: null,
    latestModel: null,
    latestModelDisplay: null,
    latestVersion: null,
    latestPermissionMode: null,
    latestCtxPct: null,
    latestCtxWindowSize: null,
    latestLimitsJson: null,
    latestCostUsd: null,
    latestStatuslineAt: null,
    status: status,
  );
}

Widget _host({required Session session, HarborApiClient? api}) {
  final _MockApi mock = api as _MockApi? ?? _MockApi();
  return ProviderScope(
    overrides: <Override>[
      harborApiClientProvider.overrideWithValue(mock),
      harborAdminTokenProvider.overrideWithValue(null),
    ],
    child: MaterialApp(
      theme: mistralLightTheme,
      home: Scaffold(
        body: ComposeBox(sessionId: session.sessionId, session: session),
      ),
    ),
  );
}

ElevatedButton _sendButton(WidgetTester tester) {
  return tester.widget<ElevatedButton>(find.byType(ElevatedButton));
}

void main() {
  testWidgets('status=active + empty → SEND disabled', (tester) async {
    await tester.pumpWidget(_host(session: _session()));
    await tester.pump();
    expect(_sendButton(tester).onPressed, isNull);
  });

  testWidgets('status=active + typed text → SEND enabled', (tester) async {
    await tester.pumpWidget(_host(session: _session()));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pump();
    expect(_sendButton(tester).onPressed, isNotNull);
  });

  testWidgets('status=ended → SEND disabled even with text', (tester) async {
    await tester.pumpWidget(_host(session: _session(status: 'ended')));
    await tester.pump();
    // Field is also disabled — Flutter TextField can still have text set.
    final TextField tf = tester.widget<TextField>(find.byType(TextField));
    expect(tf.enabled, isFalse);
    expect(_sendButton(tester).onPressed, isNull);
  });

  testWidgets('status=unbound → SEND disabled', (tester) async {
    await tester.pumpWidget(_host(session: _session(status: 'unbound')));
    await tester.pump();
    expect(_sendButton(tester).onPressed, isNull);
  });

  testWidgets('typed text + tap SEND → fetches token + posts reply + clears',
      (tester) async {
    final _MockApi api = _MockApi();
    when(() => api.adminFetchChannelToken(
          any(),
          adminToken: any(named: 'adminToken'),
        )).thenAnswer((_) async => 'tok-abc');
    when(() => api.postChannelReply(
          channelToken: any(named: 'channelToken'),
          content: any(named: 'content'),
          meta: any(named: 'meta'),
        )).thenAnswer((_) async {});

    await tester.pumpWidget(_host(session: _session(), api: api));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'ping');
    await tester.pump();
    await tester.tap(find.text('SEND'));
    await tester.pump(); // initiates async send
    await tester.pump(const Duration(milliseconds: 10));

    verify(() => api.adminFetchChannelToken('sess-1', adminToken: null))
        .called(1);
    verify(() => api.postChannelReply(
          channelToken: 'tok-abc',
          content: 'ping',
        )).called(1);
    // Text cleared after successful send.
    final TextField tf = tester.widget<TextField>(find.byType(TextField));
    expect(tf.controller?.text, isEmpty);
  });

  testWidgets('Ctrl+Enter submits and does NOT insert a newline',
      (tester) async {
    final _MockApi api = _MockApi();
    when(() => api.adminFetchChannelToken(
          any(),
          adminToken: any(named: 'adminToken'),
        )).thenAnswer((_) async => 'tok-abc');
    when(() => api.postChannelReply(
          channelToken: any(named: 'channelToken'),
          content: any(named: 'content'),
          meta: any(named: 'meta'),
        )).thenAnswer((_) async {});

    await tester.pumpWidget(_host(session: _session(), api: api));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'ping');
    await tester.pump();
    // Focus the TextField so the Focus wrapper receives the key event.
    final TextField tf = tester.widget<TextField>(find.byType(TextField));
    tf.focusNode!.requestFocus();
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));

    verify(() => api.postChannelReply(
          channelToken: 'tok-abc',
          content: 'ping',
        )).called(1);
    // Text cleared (successful submit); no stray newline inserted.
    final TextField tfAfter = tester.widget<TextField>(find.byType(TextField));
    expect(tfAfter.controller?.text, isEmpty);
    expect(tfAfter.controller?.text.contains('\n'), isFalse);
  });

  testWidgets('401 on token fetch → inline error banner shown',
      (tester) async {
    final _MockApi api = _MockApi();
    when(() => api.adminFetchChannelToken(
          any(),
          adminToken: any(named: 'adminToken'),
        )).thenThrow(const HarborApiException(401, 'unauthorized'));

    await tester.pumpWidget(_host(session: _session(), api: api));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'ping');
    await tester.pump();
    await tester.tap(find.text('SEND'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));
    expect(
      find.textContaining('HARBOR_ADMIN_TOKEN'),
      findsOneWidget,
    );
  });
}
