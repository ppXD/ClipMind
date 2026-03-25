import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Badge, Box, Button, Card, Flex, SegmentedControl, Text, TextArea, TextField } from '@radix-ui/themes';
import { DownloadIcon, PlayIcon, ReloadIcon } from '@radix-ui/react-icons';
import { buildImageStoryTimelineFromText, normalizeImageStoryTimeline } from './lib/image-story-timeline';
import type { ImageStoryItem, ImageStoryProjectRecord } from './types/workspace';

type ImageStoryPreviewEditorProps = {
  project: ImageStoryProjectRecord;
  renderedVideoUrl: string;
  onGenerate: (projectId: string) => void;
  onUpdateItems: (projectId: string, items: ImageStoryItem[]) => void;
  onDownloadFinalVideo: (projectId: string) => void;
};

export default function ImageStoryPreviewEditor({
  project,
  renderedVideoUrl,
  onGenerate,
  onUpdateItems,
  onDownloadFinalVideo,
}: ImageStoryPreviewEditorProps) {
  const segmentListRef = useRef<HTMLDivElement | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(project.items[0]?.id ?? null);
  const [viewMode, setViewMode] = useState<'edit' | 'rendered'>(renderedVideoUrl ? 'rendered' : 'edit');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const selectedItem = useMemo(
    () => project.items.find((item) => item.id === selectedItemId) ?? project.items[0] ?? null,
    [project.items, selectedItemId],
  );
  const playbackItem = useMemo(
    () => project.items.find((item) => currentTime >= item.startSec && currentTime < item.endSec) ?? project.items[0] ?? null,
    [currentTime, project.items],
  );
  const effectiveViewMode = renderedVideoUrl ? viewMode : 'edit';
  const totalTimelineDuration = Math.max(project.items.at(-1)?.endSec ?? 0, 1);
  const statusMessage = project.status === 'failed' ? project.error?.trim() || project.currentMessage : project.currentMessage;

  useEffect(() => {
    if (effectiveViewMode !== 'edit' || !isPlaying) {
      return;
    }

    const intervalId = window.setInterval(() => {
      let reachedEnd = false;
      setCurrentTime((previousTime) => {
        const nextTime = roundSeconds(previousTime + 0.1);
        reachedEnd = nextTime >= totalTimelineDuration;
        return reachedEnd ? totalTimelineDuration : nextTime;
      });

      if (reachedEnd) {
        setIsPlaying(false);
      }
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [effectiveViewMode, isPlaying, totalTimelineDuration]);

  function handleItemFieldChange(itemId: string, field: 'text' | 'startSec' | 'durationSec', value: string) {
    const nextItems = project.items.map((item) => {
      if (item.id !== itemId) {
        return item;
      }

      if (field === 'text') {
        return {
          ...item,
          [field]: value,
        };
      }

      const numericValue = Number(value);
      const safeValue = Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
      return {
        ...item,
        [field]: roundSeconds(safeValue),
      };
    });

    if (field === 'text') {
      onUpdateItems(project.id, buildImageStoryTimelineFromText(nextItems));
      return;
    }

    onUpdateItems(project.id, normalizeImageStoryTimeline(nextItems));
  }

  function handleItemJump(item: ImageStoryItem) {
    setSelectedItemId(item.id);
    setCurrentTime(item.startSec);
    const element = segmentListRef.current?.querySelector(`[data-imagestory-item-id="${item.id}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function handleItemColumnsChange(itemId: string, columns: string[]) {
    const nextColumns = columns.length ? columns : [''];
    handleItemFieldChange(itemId, 'text', joinNarrationColumns(nextColumns));
  }

  return (
    <Flex direction="column" gap="3" className="voiceover-editor-shell">
      <Flex align="center" justify="between" gap="3" className="voiceover-editor-header">
        <Box>
          <Text size="4" weight="medium">
            {project.title}
          </Text>
          <Text as="p" size="1" color="gray" mt="1">
            {project.items.length} images
          </Text>
        </Box>

        {renderedVideoUrl ? (
          <SegmentedControl.Root
            value={viewMode}
            onValueChange={(value) => {
              const nextMode = value as 'edit' | 'rendered';
              setViewMode(nextMode);
              if (nextMode !== 'edit') {
                setIsPlaying(false);
              }
            }}
            size="1"
          >
            <SegmentedControl.Item value="edit">Edit</SegmentedControl.Item>
            <SegmentedControl.Item value="rendered">Rendered</SegmentedControl.Item>
          </SegmentedControl.Root>
        ) : null}
      </Flex>

      <Card size="3" variant="surface" className="voiceover-video-card">
        <Box className="voiceover-video-frame">
          {effectiveViewMode === 'rendered' && renderedVideoUrl ? (
            <video className="voiceover-video-player" controls preload="metadata" src={renderedVideoUrl} />
          ) : (playbackItem ?? selectedItem) ? (
            <>
              <img
                className="imagestory-preview-image"
                src={(playbackItem ?? selectedItem)!.image.dataUrl}
                alt={(playbackItem ?? selectedItem)!.title}
              />
              <Box className="voiceover-subtitle-overlay">
                <Text size="4" weight="medium" className="voiceover-subtitle-text">
                  {getItemPreviewCaption(playbackItem ?? selectedItem!, currentTime)}
                </Text>
              </Box>
            </>
          ) : null}
        </Box>
      </Card>

      {effectiveViewMode === 'edit' ? (
        <Card size="1" variant="surface">
          <Flex align="center" gap="3" className="imagestory-playback-controls">
            <Button
              size="1"
              variant="soft"
              color="gray"
              onClick={() => {
                if (currentTime >= totalTimelineDuration) {
                  setCurrentTime(0);
                }
                setIsPlaying((value) => !value);
              }}
            >
              <PlayIcon />
              {isPlaying ? 'Pause' : 'Play'}
            </Button>

            <input
              className="imagestory-playback-range"
              type="range"
              min={0}
              max={totalTimelineDuration}
              step={0.1}
              value={currentTime}
              onChange={(event) => {
                setCurrentTime(Number(event.target.value));
                setIsPlaying(false);
              }}
            />

            <Text size="1" color="gray" className="imagestory-playback-time">
              {formatClock(currentTime)} / {formatClock(totalTimelineDuration)}
            </Text>
          </Flex>
        </Card>
      ) : null}

      <Flex align="center" justify="between" gap="3" className="voiceover-status-row">
        <Flex align="center" gap="2" wrap="wrap">
          <Badge variant="soft" radius="full" color={getProjectBadgeColor(project.status)}>
            {formatProjectStatus(project.status)}
          </Badge>
          <Text size="1" color={project.status === 'failed' ? 'red' : 'gray'}>
            {statusMessage}
          </Text>
          <Text size="1" color="gray">
            {project.items.length} slides · {formatSeconds(totalTimelineDuration)}
          </Text>
        </Flex>
        <Flex align="center" gap="2" wrap="wrap">
          <Button color="blue" size="1" className="voiceover-generate-button" onClick={() => onGenerate(project.id)} disabled={project.status === 'running'}>
            {project.status === 'running' ? <ReloadIcon className="spin-icon" /> : <PlayIcon />}
            {project.status === 'running' ? 'Generating…' : 'Generate'}
          </Button>
          {project.finalVideo ? (
            <Button variant="soft" color="gray" size="1" onClick={() => onDownloadFinalVideo(project.id)}>
              <DownloadIcon />
              Download MP4
            </Button>
          ) : null}
        </Flex>
      </Flex>

      <Card size="2" variant="surface" className="voiceover-timeline-card">
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">
            Timeline
          </Text>
          <Box className="voiceover-timeline-track">
            <Box
              className="voiceover-timeline-playhead"
              style={{ left: `${(currentTime / totalTimelineDuration) * 100}%` }}
            />
            <Flex className="voiceover-timeline-segments">
              {project.items.map((item, index) => {
                const isActive = selectedItem?.id === item.id;
                const isPlaying = playbackItem?.id === item.id;
                const prevEnd = index > 0 ? project.items[index - 1].endSec : 0;
                const gap = item.startSec - prevEnd;

                return (
                  <Fragment key={item.id}>
                    {gap > 0.1 ? (
                      <Box className="voiceover-timeline-gap" style={{ flexGrow: gap }} />
                    ) : null}
                    <button
                      type="button"
                      className="voiceover-timeline-segment"
                      data-active={isActive ? 'true' : 'false'}
                      data-playing={isPlaying ? 'true' : 'false'}
                      style={{ flexGrow: item.durationSec }}
                      onClick={() => handleItemJump(item)}
                    >
                      <span className="voiceover-timeline-index">{index + 1}</span>
                      <span>{truncateText(item.title, 24)}</span>
                    </button>
                  </Fragment>
                );
              })}
            </Flex>
          </Box>
        </Flex>
      </Card>

      <Box className="voiceover-segment-section">
        <Card size="2" variant="surface" className="voiceover-segment-card">
          <Flex direction="column" gap="3">
            <Text size="2" weight="medium">
              Segments
            </Text>

            <Flex ref={segmentListRef} direction="column" gap="3" className="voiceover-segment-list">
              {project.items.map((item, index) => {
                const isActive = selectedItem?.id === item.id;
                const isPlaying = playbackItem?.id === item.id;

                return (
                  <Box
                    key={item.id}
                    className="voiceover-segment-item"
                    data-active={isActive ? 'true' : 'false'}
                    data-playing={isPlaying ? 'true' : 'false'}
                    data-imagestory-item-id={item.id}
                  >
                    <Flex align="center" justify="between" gap="3" className="voiceover-segment-head">
                      <button type="button" className="voiceover-segment-title" onClick={() => handleItemJump(item)}>
                        <Flex align="center" gap="2">
                          <span className="voiceover-timeline-index">{index + 1}</span>
                          <Text size="2" weight="medium">
                            {item.title} · {formatClock(item.startSec)} - {formatClock(item.endSec)}
                          </Text>
                        </Flex>
                      </button>
                      <Flex align="center" gap="2">
                        {item.audioDurationSec ? (
                          <Badge size="1" variant="soft" radius="full" color="gray">
                            Audio {formatSeconds(item.audioDurationSec)}
                          </Badge>
                        ) : null}
                        {item.error ? (
                          <Badge size="1" variant="soft" radius="full" color="red">
                            Error
                          </Badge>
                        ) : null}
                      </Flex>
                    </Flex>

                    <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" mt="2">
                      <Box className="voiceover-segment-field">
                        <Text size="1" weight="medium">
                          Start
                        </Text>
                        <TextField.Root
                          mt="1"
                          type="number"
                          step="0.1"
                          value={item.startSec.toFixed(1)}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => handleItemFieldChange(item.id, 'startSec', event.target.value)}
                        />
                      </Box>
                      <Box className="voiceover-segment-field">
                        <Text size="1" weight="medium">
                          Duration
                        </Text>
                        <TextField.Root
                          mt="1"
                          type="number"
                          step="0.1"
                          value={item.durationSec.toFixed(1)}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => handleItemFieldChange(item.id, 'durationSec', event.target.value)}
                        />
                      </Box>
                    </Flex>

                    <Box mt="2">
                      <Flex align="center" justify="between" gap="2">
                        <Text size="1" weight="medium">
                          Narration columns
                        </Text>
                        <Button
                          size="1"
                          variant="soft"
                          color="gray"
                          onClick={() => handleItemColumnsChange(item.id, [...extractNarrationColumns(item.text), ''])}
                        >
                          Add column
                        </Button>
                      </Flex>
                      <Flex direction="column" gap="2" mt="2">
                        {extractNarrationColumns(item.text).map((columnText, columnIndex, columns) => (
                          <Box key={`${item.id}-column-${columnIndex}`}>
                            <Flex align="center" justify="between" gap="2" mb="1">
                              <Text size="1" weight="medium" color="gray">
                                Column {columnIndex + 1}
                              </Text>
                              {columns.length > 1 ? (
                                <Button
                                  size="1"
                                  variant="ghost"
                                  color="red"
                                  onClick={() =>
                                    handleItemColumnsChange(
                                      item.id,
                                      columns.filter((_, indexToKeep) => indexToKeep !== columnIndex),
                                    )
                                  }
                                >
                                  Remove
                                </Button>
                              ) : null}
                            </Flex>
                            <TextArea
                              rows={2}
                              value={columnText}
                              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                                handleItemColumnsChange(
                                  item.id,
                                  columns.map((value, indexToUpdate) =>
                                    indexToUpdate === columnIndex ? event.target.value : value,
                                  ),
                                )
                              }
                            />
                          </Box>
                        ))}
                      </Flex>
                    </Box>
                  </Box>
                );
              })}
            </Flex>
          </Flex>
        </Card>
      </Box>
    </Flex>
  );
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function formatClock(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function extractNarrationColumns(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const columns = normalized.split(/\n{2,}/).map((line) => line.trim());
  return columns.length ? columns : [''];
}

function joinNarrationColumns(columns: string[]): string {
  return columns.map((line) => line.trim()).join('\n\n');
}

function getItemPreviewCaption(item: ImageStoryItem, currentTimeSec: number): string {
  const columns = extractNarrationColumns(item.text).map((line) => line.trim()).filter(Boolean);

  if (!columns.length) {
    return item.text.trim();
  }

  if (columns.length === 1 || item.durationSec <= 0) {
    return columns[0];
  }

  const clampedTime = Math.min(Math.max(currentTimeSec, item.startSec), item.endSec);
  const relativeProgress = Math.max(0, Math.min(1, (clampedTime - item.startSec) / item.durationSec));
  const weights = columns.map((line) => Math.max(line.length, 6));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let accumulated = 0;

  for (const [index, weight] of weights.entries()) {
    accumulated += weight / totalWeight;

    if (relativeProgress <= accumulated || index === columns.length - 1) {
      return columns[index];
    }
  }

  return columns[columns.length - 1];
}

function formatProjectStatus(status: ImageStoryProjectRecord['status']): string {
  if (status === 'draft') {
    return 'Draft';
  }

  if (status === 'running') {
    return 'Running';
  }

  if (status === 'ready') {
    return 'Success';
  }

  return 'Failed';
}

function getProjectBadgeColor(status: ImageStoryProjectRecord['status']) {
  if (status === 'ready') {
    return 'green' as const;
  }

  if (status === 'running') {
    return 'blue' as const;
  }

  if (status === 'draft') {
    return 'gray' as const;
  }

  return 'red' as const;
}
