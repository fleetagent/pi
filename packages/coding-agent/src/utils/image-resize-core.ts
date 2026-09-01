import type * as PhotonNode from "@silvia-odwyer/photon-node";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton, type PhotonImageType } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}
type PhotonModule = typeof PhotonNode;

interface ImageDimensions {
	width: number;
	height: number;
}

interface SizedEncodedCandidate extends EncodedCandidate, ImageDimensions {}

interface ImageEncodingContext {
	photon: PhotonModule;
	image: PhotonImageType;
	jpegQualities: number[];
	maxBytes: number;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

function fitImageDimensions(dimensions: ImageDimensions, options: Required<ImageResizeOptions>): ImageDimensions {
	let { width, height } = dimensions;
	if (width > options.maxWidth) {
		height = Math.round((height * options.maxWidth) / width);
		width = options.maxWidth;
	}
	if (height > options.maxHeight) {
		width = Math.round((width * options.maxHeight) / height);
		height = options.maxHeight;
	}
	return { width, height };
}
function reduceImageDimensions(dimensions: ImageDimensions): ImageDimensions {
	return {
		width: dimensions.width === 1 ? 1 : Math.max(1, Math.floor(dimensions.width * 0.75)),
		height: dimensions.height === 1 ? 1 : Math.max(1, Math.floor(dimensions.height * 0.75)),
	};
}

function encodeResizedImage(context: ImageEncodingContext, dimensions: ImageDimensions): EncodedCandidate[] {
	const { photon, image, jpegQualities } = context;
	const resized = photon.resize(image, dimensions.width, dimensions.height, photon.SamplingFilter.Lanczos3);
	try {
		const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
		for (const quality of jpegQualities) {
			candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
		}
		return candidates;
	} finally {
		resized.free();
	}
}

function findSizedImageCandidate(
	context: ImageEncodingContext,
	initialDimensions: ImageDimensions,
): SizedEncodedCandidate | null {
	let current = initialDimensions;
	while (true) {
		const candidates = encodeResizedImage(context, current);
		for (const candidate of candidates) {
			if (candidate.encodedSize < context.maxBytes) return { ...candidate, ...current };
		}
		if (current.width === 1 && current.height === 1) break;
		const next = reduceImageDimensions(current);
		if (next.width === current.width && next.height === current.height) break;
		current = next;
	}
	return null;
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		const initialDimensions = fitImageDimensions({ width: originalWidth, height: originalHeight }, opts);
		const jpegQualities = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		const candidate = findSizedImageCandidate(
			{ photon, image, jpegQualities, maxBytes: opts.maxBytes },
			initialDimensions,
		);
		if (!candidate) return null;
		return {
			data: candidate.data,
			mimeType: candidate.mimeType,
			originalWidth,
			originalHeight,
			width: candidate.width,
			height: candidate.height,
			wasResized: true,
		};
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
