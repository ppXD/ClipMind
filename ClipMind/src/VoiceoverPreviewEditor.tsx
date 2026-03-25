import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Badge, Box, Button, Card, Flex, SegmentedControl, Text, TextArea, TextField } from '@radix-ui/themes';
import { DownloadIcon, PlayIcon, ReloadIcon } from '@radix-ui/react-icons';
import type { SourceMediaAsset, VoiceoverProjectRecord, VoiceoverSegment } from './types/workspace';

type VoiceoverPreviewEditorProps = {
  project: VoiceoverProjectRecord;
  sourceAsset: SourceMediaAsset;
  sourceVideoUrl: string;
  renderedVideoUrl: string;
  onGenerate: (projectId: string) => void;
  onRetranscodeSource: () => void;
  onUpdateSegments: (projectId: string, segments: VoiceoverSegment[]) => void;
  onDownloadFinalVideo: (projectId: string) => void;
};

export default function VoiceoverPreviewEditor({
  project,
  sourceVideoUrl,
  renderedVideoUrl,
  onGenerate,
  onRetranscodeSource,
  onUpdateSegments,
  onDownloadFinalVideo,
}: VoiceoverPreviewEditorProps) {
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const segmentListRef = useRef<HTMLDivElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(project.segments[0]?.id ?? null);
  const [viewMode, setViewMode] = useState<'edit' | 'rendered'>(renderedVideoUrl ? 'rendered' : 'edit');
  const [sourceVideoFailed, setSourceVideoFailed] = useState(false);
  const [isRetranscoding, setIsRetranscoding] = useState(false);
  const activeSubtitle = useMemo(
    () => project.segments.find((segment) => currentTime >= segment.startSec && currentTime < segment.endSec) ?? null,
    [currentTime, project.segments],
  );
  const selectedSegment = useMemo(
    () => project.segments.find((segment) => segment.id === selectedSegmentId) ?? project.segments[0] ?? null,
    [project.segments, selectedSegmentId],
  );
  const effectiveViewMode = renderedVideoUrl ? viewMode : 'edit';
  const editorVideoSource = effectiveViewMode === 'rendered' && renderedVideoUrl ? renderedVideoUrl : sourceVideoUrl;
  const totalTimelineDuration = Math.max(project.videoDurationSec, project.segments.at(-1)?.endSec ?? 0, 1);
  const statusMessage = project.status === 'failed' ? project.error?.trim() || project.currentMessage : project.currentMessage;

  useEffect(() => {
    if (!activeSubtitle || !segmentListRef.current) return;
    const el = segmentListRef.current.querySelector(`[data-segment-id="${activeSubtitle.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeSubtitle]);

  // Detect unplayable source video (e.g. HEVC or mpeg4 Part 2 codec).
  // Browsers silently render black frames for unsupported codecs without firing onError.
  // We detect this by checking whether `loadeddata` fires within a timeout.
  useEffect(() => {
    const video = playerRef.current;
    if (!video || !editorVideoSource || effectiveViewMode !== 'edit') return;

    let resolved = false;

    function markResolved() {
      resolved = true;
      setSourceVideoFailed(false);
      setIsRetranscoding(false);
    }

    function checkPlayability() {
      if (resolved) return;
      setSourceVideoFailed(true);
      setIsRetranscoding(false);
    }

    video.addEventListener('loadeddata', markResolved);
    const timerId = window.setTimeout(checkPlayability, 2500);

    return () => {
      video.removeEventListener('loadeddata', markResolved);
      window.clearTimeout(timerId);
    };
  }, [editorVideoSource, effectiveViewMode]);

  function handleSegmentFieldChange(segmentId: string, field: 'text' | 'subtitleText' | 'startSec' | 'durationSec', value: string) {
    const nextSegments = project.segments.map((segment) => {
      if (segment.id !== segmentId) {
        return segment;
      }

      if (field === 'text' || field === 'subtitleText') {
        return {
          ...segment,
          [field]: value,
        };
      }

      const numericValue = Number(value);
      const safeValue = Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
      return {
        ...segment,
        [field]: roundSeconds(safeValue),
      };
    });

    const normalizedSegments = normalizeSegments(nextSegments);
    onUpdateSegments(project.id, normalizedSegments);
  }

  function handleSegmentJump(segment: VoiceoverSegment) {
    setSelectedSegmentId(segment.id);

    if (!playerRef.current) {
      return;
    }

    playerRef.current.currentTime = segment.startSec;
    playerRef.current.play().catch(() => {
      // Ignore autoplay errors.
    });
  }

  return (
    <Flex direction="column" gap="3" className="voiceover-editor-shell">
      <Flex align="center" justify="between" gap="3" className="voiceover-editor-header">
        <Box>
          <Text size="4" weight="medium">
            {project.title}
          </Text>
          <Text as="p" size="1" color="gray" mt="1">
            {project.sourceOrigin}
          </Text>
        </Box>

        {renderedVideoUrl ? (
          <SegmentedControl.Root value={viewMode} onValueChange={(value) => setViewMode(value as 'edit' | 'rendered')} size="1">
            <SegmentedControl.Item value="edit">Edit</SegmentedControl.Item>
            <SegmentedControl.Item value="rendered">Rendered</SegmentedControl.Item>
          </SegmentedControl.Root>
        ) : null}
      </Flex>

      <Card size="3" variant="surface" className="voiceover-video-card">
        <Box className="voiceover-video-frame">
          <video
            ref={playerRef}
            className="voiceover-video-player"
            controls
            preload="auto"
            src={editorVideoSource}
            onTimeUpdate={(event) => setCurrentTime((event.currentTarget as HTMLVideoElement).currentTime)}
            onError={() => {
              if (effectiveViewMode === 'rendered') {
                setViewMode('edit');
              } else {
                setSourceVideoFailed(true);
                setIsRetranscoding(false);
              }
            }}
          />
          {effectiveViewMode === 'edit' && sourceVideoFailed ? (
            <Flex direction="column" align="center" justify="center" gap="3" className="voiceover-unplayable-overlay">
              <Text size="2" weight="medium" align="center">
                此视频格式无法在浏览器中播放
              </Text>
              <Text size="1" color="gray" align="center">
                点击下方按钮转码为浏览器兼容格式，或重新上传视频源。
              </Text>
              <Button
                size="2"
                variant="soft"
                onClick={() => {
                  setIsRetranscoding(true);
                  onRetranscodeSource();
                }}
                disabled={isRetranscoding}
              >
                <ReloadIcon className={isRetranscoding ? 'spin-icon' : ''} />
                {isRetranscoding ? '正在转码…' : '转码预览'}
              </Button>
            </Flex>
          ) : effectiveViewMode === 'edit' && activeSubtitle ? (
            <Box className="voiceover-subtitle-overlay">
              <Text size="4" weight="medium" className="voiceover-subtitle-text">
                {activeSubtitle.subtitleText || activeSubtitle.text}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Card>

      <Flex align="center" justify="between" gap="3" className="voiceover-status-row">
        <Flex align="center" gap="2" wrap="wrap">
          <Badge variant="soft" radius="full" color={getProjectBadgeColor(project.status)}>
            {formatProjectStatus(project.status)}
          </Badge>
          <Text size="1" color={project.status === 'failed' ? 'red' : 'gray'}>
            {statusMessage}
          </Text>
          <Text size="1" color="gray">
            {project.segments.length} segments · {formatSeconds(totalTimelineDuration)}
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
              {project.segments.map((segment, index) => {
                const isActive = selectedSegment?.id === segment.id;
                const isPlaying = activeSubtitle?.id === segment.id;
                const prevEnd = index > 0 ? project.segments[index - 1].endSec : 0;
                const gap = segment.startSec - prevEnd;

                return (
                  <Fragment key={segment.id}>
                    {gap > 0.1 ? (
                      <Box className="voiceover-timeline-gap" style={{ flexGrow: gap }} />
                    ) : null}
                    <button
                      type="button"
                      className="voiceover-timeline-segment"
                      data-active={isActive ? 'true' : 'false'}
                      data-playing={isPlaying ? 'true' : 'false'}
                      style={{ flexGrow: segment.durationSec }}
                      onClick={() => handleSegmentJump(segment)}
                    >
                      <span className="voiceover-timeline-index">{index + 1}</span>
                      <span>{truncateText(segment.text, 24)}</span>
                    </button>
                  </Fragment>
                );
              })}
              {(() => {
                const lastEnd = project.segments.at(-1)?.endSec ?? 0;
                const trailing = totalTimelineDuration - lastEnd;
                return trailing > 0.5 ? (
                  <Box className="voiceover-timeline-gap" style={{ flexGrow: trailing }} />
                ) : null;
              })()}
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
              {project.segments.map((segment, index) => {
                const isActive = selectedSegment?.id === segment.id;
                const isPlaying = activeSubtitle?.id === segment.id;

                return (
                  <Box
                    key={segment.id}
                    className="voiceover-segment-item"
                    data-active={isActive ? 'true' : 'false'}
                    data-playing={isPlaying ? 'true' : 'false'}
                    data-segment-id={segment.id}
                  >
                    <Flex align="center" justify="between" gap="3" className="voiceover-segment-head">
                      <button type="button" className="voiceover-segment-title" onClick={() => handleSegmentJump(segment)}>
                        <Flex align="center" gap="2">
                          <span className="voiceover-timeline-index">{index + 1}</span>
                          <Text size="2" weight="medium">
                            {formatClock(segment.startSec)} - {formatClock(segment.endSec)}
                          </Text>
                        </Flex>
                      </button>
                      <Flex align="center" gap="2">
                        {segment.audioDurationSec ? (
                          <Badge size="1" variant="soft" radius="full" color="gray">
                            Audio {formatSeconds(segment.audioDurationSec)}
                          </Badge>
                        ) : null}
                        {segment.error ? (
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
                          value={segment.startSec.toFixed(1)}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => handleSegmentFieldChange(segment.id, 'startSec', event.target.value)}
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
                          value={segment.durationSec.toFixed(1)}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => handleSegmentFieldChange(segment.id, 'durationSec', event.target.value)}
                        />
                      </Box>
                    </Flex>

                    <Box mt="2">
                      <Text size="1" weight="medium">
                        Script
                      </Text>
                      <TextArea
                        mt="1"
                        rows={3}
                        value={segment.text}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => handleSegmentFieldChange(segment.id, 'text', event.target.value)}
                      />
                    </Box>

                    <Box mt="2">
                      <Text size="1" weight="medium">
                        Subtitle
                      </Text>
                      <TextArea
                        mt="1"
                        rows={2}
                        value={segment.subtitleText}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => handleSegmentFieldChange(segment.id, 'subtitleText', event.target.value)}
                      />
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

function normalizeSegments(segments: VoiceoverSegment[]) {
  const sortedSegments = [...segments].sort((left, right) => left.startSec - right.startSec);

  return sortedSegments.map((segment) => {
    const durationSec = roundSeconds(Math.max(segment.durationSec, 0.1));
    const startSec = roundSeconds(Math.max(segment.startSec, 0));
    const endSec = roundSeconds(startSec + durationSec);

    return {
      ...segment,
      startSec,
      durationSec,
      endSec,
    };
  });
}

function roundSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function formatClock(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatSeconds(value: number) {
  return `${value.toFixed(1)}s`;
}

function formatProjectStatus(status: VoiceoverProjectRecord['status']) {
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

function getProjectBadgeColor(status: VoiceoverProjectRecord['status']) {
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
