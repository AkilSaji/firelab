import type { VideoCodec } from '../profile/types.js';

export type MediaTrack = {
  kind: 'video' | 'audio' | 'other';
  /** Sample entry type: avc1, avc3, hvc1, hev1, vp09, av01, mp4a, ac-3, ec-3, Opus, encv... */
  fourcc: string;
  /** Normalised video codec. */
  codec?: VideoCodec;
  /** RFC 6381 codec string, e.g. avc1.640028. */
  codecString?: string;
  /** Lower-case profile name: high, main, main10, profile0, main (av1)... */
  profile?: string;
  profileIdc?: number;
  /** "4.0", "4.2", "5.1"... */
  level?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitDepth?: number;
  durationS?: number;
  /** Track average bitrate from its sample sizes. */
  bitrateKbps?: number;
  /** Declared in a btrt box, when present. */
  maxBitrateKbps?: number;
  encrypted?: boolean;
  channels?: number;
  sampleRate?: number;
};

export type MediaInfo = {
  /** File path or URL. */
  source: string;
  container: 'mp4' | 'unknown';
  brands?: string[];
  sizeBytes?: number;
  durationS?: number;
  /** Whole-file average bitrate (size / duration). */
  bitrateKbps?: number;
  /** moov comes before mdat: playback can start before the whole file is fetched. */
  fastStart?: boolean;
  fragmented?: boolean;
  tracks: MediaTrack[];
  video?: MediaTrack;
  audio?: MediaTrack;
  /** How many bytes were read to probe it (HTTP Range requests read only headers). */
  bytesRead?: number;
  error?: string;
};

/** Random access to a file, a buffer or a URL. */
export interface ByteReader {
  readonly source: string;
  /** Total size, when known. */
  size(): Promise<number | undefined>;
  /** Up to `length` bytes from `offset` (fewer at the end). */
  read(offset: number, length: number): Promise<Buffer>;
  close?(): Promise<void>;
  /** Bytes fetched so far. */
  readonly bytesRead: number;
}
