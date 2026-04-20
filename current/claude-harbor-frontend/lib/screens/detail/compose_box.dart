import 'dart:developer' as developer;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/session.dart';
import '../../providers/harbor_providers.dart';
import '../../services/harbor_api_client.dart';
import '../../theme/mistral_theme.dart';

/// Sessions whose statuses disable the compose box.
const Set<String> kComposeDisabledStatuses = <String>{'ended', 'unbound'};

/// Cache of session_id → channel_token, scoped to the widget state. Rotated
/// on 401 by being cleared and re-fetched on the next submit.
class _TokenCache {
  final Map<String, String> _tokens = <String, String>{};

  String? get(String sessionId) => _tokens[sessionId];
  void put(String sessionId, String token) => _tokens[sessionId] = token;
  void invalidate(String sessionId) => _tokens.remove(sessionId);
}

class ComposeBox extends ConsumerStatefulWidget {
  const ComposeBox({
    required this.sessionId,
    required this.session,
    super.key,
  });

  final String sessionId;
  final Session session;

  @override
  ConsumerState<ComposeBox> createState() => _ComposeBoxState();
}

class _ComposeBoxState extends ConsumerState<ComposeBox> {
  final TextEditingController _text = TextEditingController();
  final FocusNode _focus = FocusNode();
  final _TokenCache _tokens = _TokenCache();
  bool _sending = false;
  String? _errorMessage;

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  bool get _statusDisabled =>
      kComposeDisabledStatuses.contains(widget.session.status);

  bool _canSubmitFor(TextEditingValue v) =>
      !_statusDisabled && !_sending && v.text.trim().isNotEmpty;

  bool get _canSubmit => _canSubmitFor(_text.value);

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Container(
      color: kWarmIvory,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (_errorMessage != null)
            _ComposeErrorBanner(
              message: _errorMessage!,
              onDismiss: () => setState(() => _errorMessage = null),
            ),
          if (_errorMessage != null) const SizedBox(height: 8),
          Focus(
            onKeyEvent: _handleKeyEvent,
            child: TextField(
              controller: _text,
              focusNode: _focus,
              enabled: !_statusDisabled && !_sending,
              minLines: 3,
              maxLines: 8,
              style: t.bodyLarge,
              decoration: InputDecoration(
                hintText: _statusDisabled
                    ? _disabledHintFor(widget.session.status)
                    : 'Type a reply',
                hintStyle: t.bodyLarge?.copyWith(
                  color: kMistralBlack.withValues(alpha: 0.5),
                ),
                filled: _statusDisabled || _sending,
                fillColor: kCream,
                contentPadding: const EdgeInsets.all(12),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: ValueListenableBuilder<TextEditingValue>(
              valueListenable: _text,
              builder: (BuildContext _, TextEditingValue value, Widget? __) {
                return _SendButton(
                  enabled: _canSubmitFor(value),
                  sending: _sending,
                  onPressed: _onSubmit,
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final bool isEnter = event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;
    final bool meta = HardwareKeyboard.instance.isMetaPressed;
    final bool control = HardwareKeyboard.instance.isControlPressed;
    if (meta || control) {
      if (_canSubmit) {
        // Fire-and-forget — the handler sets its own state.
        _onSubmit();
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  static String _disabledHintFor(String status) {
    switch (status) {
      case 'ended':
        return 'Session ended — replies disabled.';
      case 'unbound':
        return 'Session unbound — replies disabled.';
      default:
        return 'Replies disabled.';
    }
  }

  Future<void> _onSubmit() async {
    if (!_canSubmit) return;
    final String content = _text.text.trim();
    if (content.isEmpty) return;
    setState(() {
      _sending = true;
      _errorMessage = null;
    });
    try {
      final HarborApiClient api = ref.read(harborApiClientProvider);
      final String? adminToken = ref.read(harborAdminTokenProvider);
      String? channelToken = _tokens.get(widget.sessionId);
      channelToken ??= await api.adminFetchChannelToken(
        widget.sessionId,
        adminToken: adminToken,
      );
      _tokens.put(widget.sessionId, channelToken);
      try {
        await api.postChannelReply(
          channelToken: channelToken,
          content: content,
        );
      } on HarborApiException catch (e) {
        // Token may have rotated mid-session — invalidate + single retry.
        if (e.statusCode == 401) {
          _tokens.invalidate(widget.sessionId);
          final String fresh = await api.adminFetchChannelToken(
            widget.sessionId,
            adminToken: adminToken,
          );
          _tokens.put(widget.sessionId, fresh);
          await api.postChannelReply(
            channelToken: fresh,
            content: content,
          );
        } else {
          rethrow;
        }
      }
      if (!mounted) return;
      setState(() {
        _text.clear();
        _sending = false;
      });
    } on HarborApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _errorMessage = _friendlyError(e);
      });
    } catch (e) {
      developer.log(
        'compose submit failed',
        name: 'harbor.compose',
        error: e,
      );
      if (!mounted) return;
      setState(() {
        _sending = false;
        _errorMessage = 'Reply failed (unexpected error).';
      });
    }
  }

  String _friendlyError(HarborApiException e) {
    if (e.statusCode == 401) {
      return 'Admin token required to reply. '
          'Set HARBOR_ADMIN_TOKEN.';
    }
    return 'Reply failed (HTTP ${e.statusCode}).';
  }
}

class _SendButton extends StatelessWidget {
  const _SendButton({
    required this.enabled,
    required this.sending,
    required this.onPressed,
  });

  final bool enabled;
  final bool sending;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: enabled ? onPressed : null,
      style: ElevatedButton.styleFrom(
        backgroundColor: kMistralBlack,
        foregroundColor: Colors.white,
        disabledBackgroundColor: kCream,
        disabledForegroundColor: kMistralBlack.withValues(alpha: 0.45),
        elevation: 0,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
      ),
      child: sending
          ? const SizedBox(
              width: 14,
              height: 14,
              child: _InlineProgress(),
            )
          : const Text('SEND'),
    );
  }
}

class _InlineProgress extends StatelessWidget {
  const _InlineProgress();

  @override
  Widget build(BuildContext context) {
    return const CircularProgressIndicator(
      strokeWidth: 2,
      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
    );
  }
}

class _ComposeErrorBanner extends StatelessWidget {
  const _ComposeErrorBanner({
    required this.message,
    required this.onDismiss,
  });

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final TextTheme t = Theme.of(context).textTheme;
    return Container(
      decoration: const BoxDecoration(
        color: kWarmIvory,
        border: Border(
          left: BorderSide(color: kMistralOrange, width: 2),
        ),
      ),
      padding: const EdgeInsets.all(12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Text(
              message,
              style: t.bodyLarge?.copyWith(color: kMistralBlack),
            ),
          ),
          const SizedBox(width: 8),
          InkWell(
            onTap: onDismiss,
            customBorder: const RoundedRectangleBorder(
              borderRadius: BorderRadius.zero,
            ),
            child: const Padding(
              padding: EdgeInsets.all(4),
              child: Icon(
                Icons.close,
                size: 16,
                color: kMistralBlack,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
