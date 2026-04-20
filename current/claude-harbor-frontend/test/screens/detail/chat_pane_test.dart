import 'package:claude_harbor_frontend/models/message.dart';
import 'package:claude_harbor_frontend/models/session.dart';
import 'package:claude_harbor_frontend/providers/harbor_providers.dart';
import 'package:claude_harbor_frontend/screens/detail/chat_pane.dart';
import 'package:claude_harbor_frontend/theme/mistral_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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

Message _msg({
  required int id,
  required MessageDirection direction,
  required int createdAt,
  String content = 'hello world',
}) {
  return Message(
    id: id,
    sessionId: 'sess-1',
    direction: direction,
    content: content,
    metaJson: null,
    createdAt: createdAt,
  );
}

Widget _host({required List<Message> messages, Session? session}) {
  return ProviderScope(
    overrides: <Override>[
      messagesProvider.overrideWith(
        (ref, id) => Stream<List<Message>>.value(messages),
      ),
    ],
    child: MaterialApp(
      theme: mistralLightTheme,
      home: Scaffold(
        body: SizedBox(
          width: 800,
          height: 600,
          child: ChatPane(
            sessionId: 'sess-1',
            session: session ?? _session(),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('empty → "No messages yet." caption', (tester) async {
    await tester.pumpWidget(_host(messages: const <Message>[]));
    await tester.pump();
    expect(find.text('No messages yet.'), findsOneWidget);
  });

  testWidgets('inbound bubble right-aligned with kCream background',
      (tester) async {
    final Message m = _msg(
      id: 1,
      direction: MessageDirection.inbound,
      createdAt: DateTime(2026, 4, 20, 10).millisecondsSinceEpoch,
      content: 'hi from user',
    );
    await tester.pumpWidget(_host(messages: <Message>[m]));
    await tester.pump();
    expect(find.text('hi from user'), findsOneWidget);
    final Align align = tester.widget(find.ancestor(
      of: find.text('hi from user'),
      matching: find.byType(Align),
    ).first);
    expect(align.alignment, Alignment.centerRight);
    // The nearest Container has the kCream decoration.
    final Container container = tester.widget(find.ancestor(
      of: find.text('hi from user'),
      matching: find.byType(Container),
    ).first);
    expect((container.decoration as BoxDecoration).color, kCream);
  });

  testWidgets('outbound bubble left-aligned with left orange border',
      (tester) async {
    final Message m = _msg(
      id: 2,
      direction: MessageDirection.outbound,
      createdAt: DateTime(2026, 4, 20, 10).millisecondsSinceEpoch,
      content: 'response from Claude',
    );
    await tester.pumpWidget(_host(messages: <Message>[m]));
    await tester.pump();
    expect(find.text('response from Claude'), findsOneWidget);
    final Align align = tester.widget(find.ancestor(
      of: find.text('response from Claude'),
      matching: find.byType(Align),
    ).first);
    expect(align.alignment, Alignment.centerLeft);
    final Container container = tester.widget(find.ancestor(
      of: find.text('response from Claude'),
      matching: find.byType(Container),
    ).first);
    final BoxDecoration decoration = container.decoration! as BoxDecoration;
    expect(decoration.color, kWarmIvory);
    expect(decoration.border, isA<Border>());
    final Border border = decoration.border! as Border;
    expect(border.left.color, kMistralOrange);
    expect(border.left.width, 2);
  });

  testWidgets('single message → no timestamp label (no previous msg)',
      (tester) async {
    final int base = DateTime(2026, 4, 20, 10).millisecondsSinceEpoch;
    await tester.pumpWidget(_host(messages: <Message>[
      _msg(
        id: 1,
        direction: MessageDirection.inbound,
        createdAt: base,
        content: 'only',
      ),
    ]));
    await tester.pump();
    // No label on the first chronological message — it'd render at the
    // visual bottom under reverse:true, which reads wrong.
    expect(find.text('10:00'), findsNothing);
    expect(find.text('only'), findsOneWidget);
  });

  testWidgets('timestamp label appears ABOVE newer message on >60s gap',
      (tester) async {
    final int base = DateTime(2026, 4, 20, 10).millisecondsSinceEpoch;
    final List<Message> msgs = <Message>[
      _msg(
        id: 1,
        direction: MessageDirection.inbound,
        createdAt: base,
        content: 'first',
      ),
      _msg(
        id: 2,
        direction: MessageDirection.outbound,
        createdAt: base + 120 * 1000, // 120s later → triggers label on #2
        content: 'second',
      ),
    ];
    await tester.pumpWidget(_host(messages: msgs));
    await tester.pump();
    // Only the newer (second) message's timestamp label is rendered.
    expect(find.text('10:02'), findsOneWidget);
    expect(find.text('10:00'), findsNothing);
  });

  testWidgets('timestamp label NOT shown between close-in-time messages',
      (tester) async {
    final int base = DateTime(2026, 4, 20, 10).millisecondsSinceEpoch;
    final List<Message> msgs = <Message>[
      _msg(
        id: 1,
        direction: MessageDirection.inbound,
        createdAt: base,
        content: 'first',
      ),
      _msg(
        id: 2,
        direction: MessageDirection.outbound,
        createdAt: base + 30 * 1000, // 30s later → no label
        content: 'second',
      ),
    ];
    await tester.pumpWidget(_host(messages: msgs));
    await tester.pump();
    // No timestamp labels anywhere — neither on the first message nor on
    // the second (gap < kTimestampGroupGap).
    expect(find.text('10:00'), findsNothing);
    expect(find.text('10:00 ').evaluate(), isEmpty);
  });

  test('formatTimestamp: same day → HH:mm; cross-day → yyyy-MM-dd HH:mm',
      () {
    final DateTime now = DateTime(2026, 4, 20, 15, 30);
    final int sameDay = DateTime(2026, 4, 20, 9, 5).millisecondsSinceEpoch;
    final int otherDay = DateTime(2026, 4, 19, 23, 5).millisecondsSinceEpoch;
    expect(formatTimestamp(sameDay, now: now), '09:05');
    expect(formatTimestamp(otherDay, now: now), '2026-04-19 23:05');
  });
}
