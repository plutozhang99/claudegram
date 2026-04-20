import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/rate_limits.dart';
import '../../models/session.dart';
import '../../theme/mistral_theme.dart';
import '../../widgets/section_label.dart';
import '../sessions/session_tile.dart' show statusDotColor, statusLabel;

/// Courier style reused for literal values (cost, paths, ctx-tokens).
const TextStyle kMetadataCourier = TextStyle(
  fontFamily: 'Courier',
  fontSize: 14,
  height: 1.43,
  fontWeight: FontWeight.w400,
  color: kMistralBlack,
);

class MetadataPane extends StatelessWidget {
  const MetadataPane({required this.session, super.key});

  final Session session;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _ProjectSection(session: session),
          const _SectionDivider(),
          _ModelSection(session: session),
          const _SectionDivider(),
          _ContextSection(session: session),
          const _SectionDivider(),
          _LimitsSection(session: session),
          const _SectionDivider(),
          _CostSection(session: session),
          const _SectionDivider(),
          _StatusSection(session: session),
        ],
      ),
    );
  }
}

class _SectionDivider extends StatelessWidget {
  const _SectionDivider();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 16),
      child: Divider(color: kInputBorder, height: 1),
    );
  }
}

class _ProjectSection extends StatelessWidget {
  const _ProjectSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'PROJECT'),
        const SizedBox(height: 12),
        _KVRow(key_: 'project_dir', value: session.projectDir ?? '\u2014'),
        const SizedBox(height: 8),
        _KVRow(key_: 'cwd', value: session.cwd ?? '\u2014'),
      ],
    );
  }
}

class _ModelSection extends StatelessWidget {
  const _ModelSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final String model = session.latestModelDisplay ??
        session.latestModel ??
        '\u2014';
    final String? version = session.latestVersion;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'MODEL'),
        const SizedBox(height: 12),
        Text(model, style: Theme.of(context).textTheme.bodyLarge),
        if (version != null) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            version,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: kMistralBlack.withValues(alpha: 0.65),
                ),
          ),
        ],
      ],
    );
  }
}

class _ContextSection extends StatelessWidget {
  const _ContextSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final double? pct = session.latestCtxPct;
    final int? window = session.latestCtxWindowSize;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'CONTEXT'),
        const SizedBox(height: 12),
        Center(
          child: SizedBox(
            width: 96,
            height: 96,
            child: CustomPaint(
              painter: _ContextRingPainter(
                percent: (pct ?? 0).clamp(0, 100).toDouble(),
                hasValue: pct != null,
              ),
              child: Center(
                child: Text(
                  pct == null ? '—' : '${pct.toInt()}%',
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Center(
          child: Text(
            window == null ? '— tokens' : '$window tokens',
            style: kMetadataCourier,
          ),
        ),
      ],
    );
  }
}

class _ContextRingPainter extends CustomPainter {
  _ContextRingPainter({required this.percent, required this.hasValue});

  final double percent;
  final bool hasValue;

  @override
  void paint(Canvas canvas, Size size) {
    final double stroke = 8;
    final double radius = (math.min(size.width, size.height) - stroke) / 2;
    final Offset center = Offset(size.width / 2, size.height / 2);

    final Paint trackPaint = Paint()
      ..color = kCream
      ..strokeWidth = stroke
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.butt;
    canvas.drawCircle(center, radius, trackPaint);

    if (!hasValue) return;
    final Paint fillPaint = Paint()
      ..color = kMistralOrange
      ..strokeWidth = stroke
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.butt;
    final double sweep = (percent / 100.0) * 2 * math.pi;
    const double startAngle = -math.pi / 2;
    final Rect rect = Rect.fromCircle(center: center, radius: radius);
    canvas.drawArc(rect, startAngle, sweep, false, fillPaint);
  }

  @override
  bool shouldRepaint(covariant _ContextRingPainter old) =>
      old.percent != percent || old.hasValue != hasValue;
}

class _LimitsSection extends StatelessWidget {
  const _LimitsSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final RateLimits? rl = session.rateLimits;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'LIMITS'),
        const SizedBox(height: 12),
        _LimitBar(label: '5h', window: rl?.fiveHour),
        const SizedBox(height: 12),
        _LimitBar(label: '7d', window: rl?.sevenDay),
      ],
    );
  }
}

class _LimitBar extends StatelessWidget {
  const _LimitBar({required this.label, required this.window});

  final String label;
  final RateWindow? window;

  @override
  Widget build(BuildContext context) {
    final double? pct = window?.usedPercentage;
    final double clamped = (pct ?? 0).clamp(0, 100).toDouble();
    final TextStyle? base = Theme.of(context).textTheme.bodySmall;
    final String percentLabel = pct == null ? '—' : '${clamped.toInt()}%';
    final DateTime? resetsAt = window?.resetsAt;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Text(label, style: base),
            const Spacer(),
            Text(percentLabel, style: base),
          ],
        ),
        const SizedBox(height: 4),
        SizedBox(
          height: 6,
          child: LayoutBuilder(
            builder: (BuildContext _, BoxConstraints c) {
              return Stack(
                children: <Widget>[
                  Container(color: kCream),
                  if (pct != null)
                    Container(
                      width: c.maxWidth * (clamped / 100.0),
                      color: kMistralOrange,
                    ),
                ],
              );
            },
          ),
        ),
        if (resetsAt != null) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            'resets ${_formatResetAt(resetsAt)}',
            style: base?.copyWith(
              color: kMistralBlack.withValues(alpha: 0.6),
            ),
          ),
        ],
      ],
    );
  }
}

String _formatResetAt(DateTime at) {
  final DateTime local = at.toLocal();
  final String hh = local.hour.toString().padLeft(2, '0');
  final String mm = local.minute.toString().padLeft(2, '0');
  final DateTime now = DateTime.now();
  final bool sameDay = local.year == now.year &&
      local.month == now.month &&
      local.day == now.day;
  if (sameDay) return '$hh:$mm';
  final String yyyy = local.year.toString().padLeft(4, '0');
  final String mon = local.month.toString().padLeft(2, '0');
  final String dd = local.day.toString().padLeft(2, '0');
  return '$yyyy-$mon-$dd $hh:$mm';
}

class _CostSection extends StatelessWidget {
  const _CostSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final double? cost = session.latestCostUsd;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'COST'),
        const SizedBox(height: 12),
        Text(
          cost == null ? '—' : '\$${cost.toStringAsFixed(2)}',
          style: kMetadataCourier,
        ),
      ],
    );
  }
}

class _StatusSection extends StatelessWidget {
  const _StatusSection({required this.session});

  final Session session;

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const SectionLabel(label: 'STATUS'),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            Container(
              width: 12,
              height: 12,
              color: statusDotColor(session.status),
            ),
            const SizedBox(width: 8),
            Text(statusLabel(session.status), style: t.bodyLarge),
          ],
        ),
        if (session.accountHint != null) ...<Widget>[
          const SizedBox(height: 8),
          _KVRow(key_: 'account', value: session.accountHint!),
        ],
        if (session.status == 'ended' && session.endedReason != null) ...<Widget>[
          const SizedBox(height: 8),
          _KVRow(key_: 'ended_reason', value: session.endedReason!),
        ],
      ],
    );
  }
}

class _KVRow extends StatelessWidget {
  const _KVRow({required this.key_, required this.value});

  final String key_;
  final String value;

  @override
  Widget build(BuildContext context) {
    final TextStyle? caption = Theme.of(context).textTheme.bodySmall?.copyWith(
          color: kMistralBlack.withValues(alpha: 0.6),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(key_, style: caption),
        const SizedBox(height: 2),
        Text(value, style: kMetadataCourier),
      ],
    );
  }
}
