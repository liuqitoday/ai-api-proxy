// Short human-readable previews of request/response bodies for the dashboard list.
const PREVIEW_CHARS = 80;
const LABELLED_CHARS = 70;

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ');
}

function clip(value, max = PREVIEW_CHARS) {
  return value.slice(0, max);
}

function previewRequest(body) {
  if (!body || typeof body !== 'object') return '';

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const text = textFromContent(body.messages[body.messages.length - 1].content);
    if (text) return clip(text);
  }

  if (typeof body.input === 'string') return clip(body.input);
  if (Array.isArray(body.input)) {
    const text = body.input
      .map(item => textFromContent(item && item.content))
      .filter(Boolean)
      .join(' ');
    if (text) return clip(text);
  }

  return '';
}

function previewResponse(body) {
  if (!body || typeof body !== 'object') return '';

  if (Array.isArray(body.content)) {
    const text = textFromContent(body.content);
    if (text) return clip(text);
  }

  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!item || item.type !== 'message') continue;
      const text = textFromContent(item.content);
      if (text) return clip(text);
    }
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice && choice.message;
  if (message) {
    const text = textFromContent(message.content);
    if (text) return clip(text);
    if (message.refusal) return clip('[Refusal] ' + message.refusal, LABELLED_CHARS);
  }

  if (body.error) {
    const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    return clip('[Error] ' + detail, LABELLED_CHARS);
  }

  if (typeof body._raw_stream === 'string') {
    return clip('[Raw Stream] ' + body._raw_stream, LABELLED_CHARS);
  }

  return '';
}

module.exports = { previewRequest, previewResponse, PREVIEW_CHARS };
