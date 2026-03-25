const subtitleCanvasWidth = 1280;
const subtitleCanvasHeight = 720;
const subtitleBottomMargin = 34;
const subtitleHorizontalPadding = 14;
const subtitleVerticalPadding = 8;
const subtitleSideSafeInset = 112;

export async function renderSubtitleBurnedImage({
  imageDataUrl,
  subtitleText,
  language,
}: {
  imageDataUrl: string;
  subtitleText: string;
  language: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = subtitleCanvasWidth;
      canvas.height = subtitleCanvasHeight;
      const context = canvas.getContext('2d');

      if (!context) {
        reject(new Error('Failed to create canvas context for subtitle rendering.'));
        return;
      }

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, subtitleCanvasWidth, subtitleCanvasHeight);
      drawContainImage(context, image);
      drawSubtitleCard(context, subtitleText, language);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Failed to load image while rendering subtitles.'));
    image.src = imageDataUrl;
  });
}

export async function renderSubtitleOverlayImage({
  subtitleText,
  language,
}: {
  subtitleText: string;
  language: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = subtitleCanvasWidth;
    canvas.height = subtitleCanvasHeight;
    const context = canvas.getContext('2d');

    if (!context) {
      reject(new Error('Failed to create canvas context for subtitle overlay rendering.'));
      return;
    }

    drawSubtitleCard(context, subtitleText, language);
    resolve(canvas.toDataURL('image/png'));
  });
}

function drawContainImage(context: CanvasRenderingContext2D, image: HTMLImageElement) {
  const scale = Math.min(subtitleCanvasWidth / image.width, subtitleCanvasHeight / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const drawX = (subtitleCanvasWidth - drawWidth) / 2;
  const drawY = (subtitleCanvasHeight - drawHeight) / 2;
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function drawSubtitleCard(context: CanvasRenderingContext2D, subtitleText: string, language: string) {
  const normalizedText = subtitleText.trim();
  if (!normalizedText) {
    return;
  }

  const cjk = isCjkLanguage(language) || isCjkText(normalizedText);
  const fontSize = cjk ? 38 : 40;
  const lineHeight = Math.round(fontSize * 1.2);
  const maxBoxWidth = subtitleCanvasWidth - subtitleSideSafeInset * 2;
  const maxTextWidth = Math.max(260, maxBoxWidth - subtitleHorizontalPadding * 2 - 8);
  context.font = `700 ${fontSize}px ${cjk ? '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' : '"Helvetica Neue", Arial, sans-serif'}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const lines = wrapSubtitleLines(context, normalizedText, maxTextWidth);
  if (!lines.length) {
    return;
  }

  const maxLineWidth = Math.max(...lines.map((line) => context.measureText(line).width));
  const boxWidth = Math.min(maxBoxWidth, maxLineWidth + subtitleHorizontalPadding * 2);
  const boxHeight = lines.length * lineHeight + subtitleVerticalPadding * 2;
  const boxX = (subtitleCanvasWidth - boxWidth) / 2;
  const boxY = subtitleCanvasHeight - boxHeight - subtitleBottomMargin;

  context.fillStyle = 'rgba(0, 0, 0, 0.58)';
  context.beginPath();
  roundRect(context, boxX, boxY, boxWidth, boxHeight, 8);
  context.fill();

  context.fillStyle = '#ffffff';
  context.strokeStyle = 'rgba(20, 20, 20, 0.7)';
  context.lineWidth = 2.5;
  context.lineJoin = 'round';

  const textBlockHeight = lines.length * lineHeight;
  const textStartY = boxY + (boxHeight - textBlockHeight) / 2;

  for (const [index, line] of lines.entries()) {
    const x = subtitleCanvasWidth / 2;
    const y = textStartY + index * lineHeight + lineHeight / 2;
    context.strokeText(line, x, y);
    context.fillText(line, x, y);
  }
}

function wrapSubtitleLines(context: CanvasRenderingContext2D, subtitleText: string, maxWidth: number): string[] {
  const normalizedLines = subtitleText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const result: string[] = [];

  for (const rawLine of normalizedLines.length ? normalizedLines : [subtitleText.trim()]) {
    if (!rawLine) {
      continue;
    }

    const hasWhitespace = /\s/.test(rawLine);
    const tokens = hasWhitespace ? rawLine.split(/\s+/).filter(Boolean) : [rawLine];
    let currentLine = '';

    for (const token of tokens) {
      const chunks = splitTokenToFitWidth(context, token, maxWidth);

      for (const [chunkIndex, chunk] of chunks.entries()) {
        const needSpace = hasWhitespace && chunkIndex === 0 && currentLine.length > 0;
        const candidateLine = needSpace ? `${currentLine} ${chunk}` : `${currentLine}${chunk}`;

        if (!currentLine || context.measureText(candidateLine).width <= maxWidth) {
          currentLine = candidateLine;
          continue;
        }

        if (currentLine.trim()) {
          result.push(currentLine.trimEnd());
        }
        currentLine = chunk;
      }
    }

    if (currentLine.trim()) {
      result.push(currentLine.trimEnd());
    }
  }

  return result;
}

function splitTokenToFitWidth(context: CanvasRenderingContext2D, token: string, maxWidth: number): string[] {
  if (!token) {
    return [];
  }

  if (context.measureText(token).width <= maxWidth) {
    return [token];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  for (const char of Array.from(token)) {
    const candidateChunk = `${currentChunk}${char}`;

    if (!currentChunk || context.measureText(candidateChunk).width <= maxWidth) {
      currentChunk = candidateChunk;
      continue;
    }

    chunks.push(currentChunk);
    currentChunk = char;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function isCjkLanguage(language: string): boolean {
  const lower = language.toLowerCase();
  return lower.includes('cantonese') || lower.includes('mandarin') || lower.includes('chinese') || lower.includes('japanese') || lower.includes('korean');
}

function isCjkText(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(text);
}
