import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/rate_limits.dart';
import '../../models/session.dart';
import '../../providers/harbor_providers.dart';
import '../../theme/mistral_theme.dart';
import '../sessions/session_tile.dart' show statusDotColor, statusLabel;
import 'metadata_pane.dart';

/// Mobile (<960 px) condensed one-row summary rendered above the chat.
/// Tap opens a modal bottom sheet with the full [MetadataPane].
class MetadataCollapsed extends StatelessWidget {
  const MetadataCollapsed({required this.session, super.key});

  final Session session;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: kWarmIvory,
      child: InkWell(
        onTap: () => _showFullSheet(context, session.sessionId),
        customBorder: const RoundedRectangleBorder(
          borderRadius: BorderRadius.zero,
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48, maxHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: _SummaryRow(session: session),
          ),
        ),
      ),
    );
  }

  static void _showFullSheet(BuildContext context, String sessionId) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: kWarmIvory,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
      isScrollControlled: true,
      builder: (BuildContext sheetContext) {
        return SafeArea(
          child: SizedBox(
            height: MediaQuery.of(sheetContext).size.height * 0.85,
            child: _MetadataSheetBody(sessionId: sessionId),
          ),
        );
      },
    );
  }
}

/// Narrow-layout bottom-sheet body. Watches [sessionDetailProvider] so
/// that live provider updates while the sheet is open are reflected —
/// passing the `Session` by value at open time would capture a stale
/// snapshot.
class _MetadataSheetBody extends ConsumerWidget {
  const _MetadataSheetBody({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<Session> async =
        ref.watch(sessionDetailProvider(sessionId));
    return async.when(
      loading: () => const ColoredBox(color: kWarmIvory),
      error: (Object _, StackTrace __) => const ColoredBox(color: kWarmIvory),
      data: (Session session) => MetadataPane(session: session),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final TextStyle? body =
        Theme.of(context).textTheme.bodySmall?.copyWith(fontSize: 14);
    final String model =
        session.latestModelDisplay ?? session.latestModel ?? '\u2014';
    final String ctxLabel = session.latestCtxPct == null
        ? '—'
        : '${session.latestCtxPct!.toInt()}%';
    final RateLimits? rl = session.rateLimits;
    final String fhLabel = rl?.fiveHour?.usedPercentage == null
        ? '—'
        : '${rl!.fiveHour!.usedPercentage.toInt()}%';
    final String sdLabel = rl?.sevenDay?.usedPercentage == null
        ? '—'
        : '${rl!.sevenDay!.usedPercentage.toInt()}%';
    final String cost = session.latestCostUsd == null
        ? '—'
        : '\$${session.latestCostUsd!.toStringAsFixed(2)}';
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            '$model  \u00b7  ctx $ctxLabel  \u00b7  5h $fhLabel  \u00b7  '
            '7d $sdLabel  \u00b7  $cost',
            style: body,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 8),
        Tooltip(
          message: statusLabel(session.status),
          child: Container(
            width: 12,
            height: 12,
            color: statusDotColor(session.status),
          ),
        ),
      ],
    );
  }
}
