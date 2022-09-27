const TAG = "[Scanner]";
const CANVAS_ID = "scene";
const FRAME_RATE = 30;
const WORKER_SCRIPT_PATH = "worker/zxing-0.18.6-worker.js";

/**
 * @typedef {number} ScannerFormats
 * @enum {ScannerFormats}
 */
const SCANNER_FORMATS = {
	UNKNOWN: 0,
	DATA_MATRIX: 1, // Europe
	GS1_DATABAR_LIMITED_COMPOSITE: 2 // Japan
}

/**
 * @param {HTMLElement} domElement
 * @param {{ [format]: ScannerFormats, [isTestingMode]: boolean }} [options]
 * @constructor
 */
function Scanner(domElement, options) {
	let canvas, context;
	let videoElement, videoStream;
	let overlay;
	let worker;
	let workerPath = WORKER_SCRIPT_PATH;
	let facingMode = "environment";
	let scannerFormat = SCANNER_FORMATS.DATA_MATRIX;
	let isDrawingLoopActive = false;
	let isTestingMode = false;

	// public methods

	/**
	 * @param {{ [facingMode]: "environment" | "user", [useBasicSetup]: boolean }} [options]
	 * @return {Promise<void>}
	 */
	this.setup = async (options) => {
		if (typeof options !== 'object') {
			options = {};
		}
		if ((["environment", "user"].includes(options.facingMode))) {
			facingMode = options.facingMode;
		}
		if (typeof options.useBasicSetup !== 'boolean') {
			options.useBasicSetup = true;
		}

		reset();
		internalSetup();

		if (!options.useBasicSetup) {
			await connectCamera();
		}
	}

	/**
	 * @return {void}
	 */
	this.shutDown = () => {
		reset();

		if (worker) {
			worker.terminate();
		}

		if (domElement.children.length) {
			domElement.innerHTML = "";
		}
	}

	/**
	 * @param {ImageData} [imageData]
	 * @return {Promise<Result | undefined>}
	 */
	this.scan = async (imageData) => {
		if (imageData instanceof ImageData) {
			return await scanFromImageData(imageData);
		}

		return await scanFromStream();
	}

	/**
	 * @param {string} path
	 * @return {void}
	 */
	this.changeWorkerScript = (path) => {
		workerPath = path;
	}

	/**
	 * @param {{ width: number, height: number }} canvasDimensions
	 * @return {number[]} meaning [x, y, width, height]
	 */
	this.getScanningArea = (canvasDimensions) => {
		let scannerDimensions = getDefaultScannerDimensions(scannerFormat, canvasDimensions);
		return [
			(canvasDimensions.width - scannerDimensions.width) / 2,
			(canvasDimensions.height - scannerDimensions.height) / 2,
			scannerDimensions.width,
			scannerDimensions.height
		];
	}

	/**
	 * @param {{ width: number, height: number }} canvasDimensions
	 * @param {number[]} scannerArea
	 * @return {HTMLCanvasElement}
	 */
	this.drawOverlay = (canvasDimensions, scannerArea) => {
		return getDefaultScannerOverlay(scannerFormat, scannerArea, canvasDimensions);
	}

	// private methods

	const applyOptions = (options) => {
		if (typeof options !== 'object') {
			options = {};
		}
		if (Object.values(SCANNER_FORMATS).includes(options.format)) {
			scannerFormat = options.format;
		}
		if (typeof options.isTestingMode === 'boolean') {
			isTestingMode = options.isTestingMode;
		}
	}

	const reset = () => {
		if (overlay) {
			overlay.remove();
			overlay = null;
		}

		if (context && context) {
			context.clearRect(0, 0, canvas.width, canvas.height)
		}

		if (videoStream) {
			try {
				videoStream.getVideoTracks()[0].stop();
			} catch (err) {
				console.log(TAG, "Caught an error during video track stop process.", err);
			}
		}

		if (isDrawingLoopActive) {
			isDrawingLoopActive = false;
		}
	}

	const internalSetup = () => {
		let id = CANVAS_ID;

		if (!domElement.querySelector("#" + id)) {
			canvas = document.createElement("canvas");
			canvas.id = id;
			canvas.style.position = 'absolute';
			canvas.style.top = '50%';
			canvas.style.left = '50%';
			canvas.style.transform = 'translate(-50%, -50%)';

			domElement.style.position = 'absolute';
			domElement.style.top = 0;
			domElement.style.bottom = 0;
			domElement.style.width = '100%';

			domElement.append(canvas);
		} else {
			canvas = domElement.querySelector('#' + id);
		}

		if (canvas) {
			context = canvas.getContext("2d");
			context.imageSmoothingEnabled = false;
		}
	}

	const decode = (imageData) => {
		return new Promise((resolve, reject) => {
			let segments = workerPath.split("/");
			segments.pop();
			let basePath = segments.join("/")+segments.length > 1 ? "/" : "";

			if (!worker) {
				worker = new Worker(workerPath);
				worker.postMessage({
					type: "init",
					payload:{
						basePath
					}
				});
			}

			let waitFor = (message) => {
				try {
					let result;
					let event = message.data;
					let messageType = event.type;
					switch (messageType) {
						case "decode-fail":
							break;
						case "decode-success":
							result = event.payload.result;
							break;
						default:
							console.log(TAG, "Caught a strange message");
							result = event;
					}

					worker.removeEventListener("message", waitFor);
					worker.removeEventListener("error", errorHandler);
					resolve(result);
				} catch (err) {
					console.log(TAG, err);
				}
			}

			let errorHandler = (...args) => {
				worker = undefined;
				reject(...args);
			};

			worker.addEventListener("message", waitFor);

			worker.addEventListener("error", errorHandler);

			worker.postMessage({
				type: "decode",
				payload: {
					scannerFormat,
					imageData,
					filterId: ""
				}
			});
		});
	}

	const connectCamera = async () => {
		return new Promise(async (resolve, reject) => {
			let stream;
			let constraints = {
				audio: false,
				video: { facingMode },
				advanced: [{ focusMode: "continuous" }]
			};

			try {
				stream = await window.navigator.mediaDevices.getUserMedia(constraints);
				const track = stream.getVideoTracks()[0];
				// const capabilities = track.getCapabilities();
				// console.log(TAG, "Camera capabilities", capabilities);

				constraints.video.height = 1080;
				constraints.video.width = 1920;

				await track.applyConstraints(constraints.video);
			} catch (error) {
				console.log(TAG, "Caught an error during camera connection", error);
				return reject(error);
			}

			let video = document.createElement('video');
			video.autoplay = true;
			video.muted = true;
			video.loop = true;
			if (!gotFullSupport()) {
				video.width = 1;
				video.height = 1;
				video.setAttribute("playsinline", "");
			}
			video.addEventListener("loadeddata", () => {
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;

				isDrawingLoopActive = true;
				startDrawingLoop();

				resolve(true);
			});
			video.addEventListener("error", (e) => reject(e.error));

			videoElement = video;
			videoStream = stream;

			video.srcObject = stream;

			// enable autoplay video for Safari desktop and mobile
			if (!gotFullSupport()) {
				domElement.append(video);
			}
		});
	}

	const getDataForScanning = () => {
		let centralArea = this.getScanningArea(canvas);
		let frameAsImageData = context.getImageData(...centralArea);

		if (isTestingMode) {
			this.lastScanInput = frameAsImageData;
			this.lastFrame = context.getImageData(0, 0, canvas.width, canvas.height);
		}

		return frameAsImageData;
	}
	
	const gotFullSupport = () => {
		return !!window.ImageCapture;
	}
	
	const grabFrameFromStream = async () => {
		if (!gotFullSupport()) {
			return grabFrameAlternative();
		}

		let frame;
		try {
			const track = videoStream.getVideoTracks()[0];
			const imageCapture = new ImageCapture(track);
			frame = await imageCapture.grabFrame();
		} catch (err) {
			console.log(TAG, "Got a situation during grabFrame from stream process.", err);
		}
		return frame;
	}

	const grabFrameAlternative = () => {
		let tempCanvas = document.createElement("canvas");
		let tempContext = tempCanvas.getContext("2d");
		let {width, height} = canvas;
		tempCanvas.width = width;
		tempCanvas.height = height;

		tempContext.drawImage(videoElement, 0, 0, width, height);
		return tempCanvas;
	}

	const scanFromStream = async () => {
		let frame = getDataForScanning();
		return await decode(frame);
	}

	const scanFromImageData = async (imageData) => {
		canvas.width = imageData.width;
		canvas.height = imageData.height;

		let tempCanvas = document.createElement("canvas");
		let tempContext = tempCanvas.getContext("2d");
		let {width, height} = canvas;
		tempCanvas.width = width;
		tempCanvas.height = height;

		tempContext.putImageData(imageData, 0, 0);

		//give feedback to user
		await drawFrame(tempCanvas);

		//scan every 10 frame for any codes
		//this is a temporary fix until ios wrapper will be fixed
		//there are some threads that are shutting down random
		if (!this.scanCounter) {
			this.scanCounter = 10;
		}
		this.scanCounter--;
		if (this.scanCounter === 0) {
			this.scanCounter = undefined;
			return await decode(getDataForScanning());
		}
	}

	const drawFrame = async (frame) => {
		const { width, height } = canvas;

		if (!overlay) {
			let scannerArea = this.getScanningArea(canvas);
			overlay = this.drawOverlay(canvas, scannerArea);
			overlay && domElement.append(overlay);
		}

		if (!frame) {
			frame = await grabFrameFromStream();
		}

		if (!frame) {
			console.log(TAG, "Dropping frame");
			return;
		}

		context.drawImage(frame, 0, 0, width, height);
	}

	const startDrawingLoop = async () => {
		if (isDrawingLoopActive) {
			const startDrawing = Date.now();

			await drawFrame();

			const drawingTime = Date.now() - startDrawing;

			const sleepTime = FRAME_RATE - drawingTime;

			if (sleepTime > 0) {
				await timeout(sleepTime);
			}

			await startDrawingLoop();
		}
	}

	// legacy

	/**
	 * @deprecated
	 */
	this.changeWorker = (path) => {
		console.log(TAG, 'method changeWorker is deprecated, use changeWorkerScript instead!');
		this.changeWorkerScript(path)
	}

	/**
	 * @deprecated
	 */
	this.scanImageData = async (imageData) => {
		console.log(TAG, 'method scanImageData is deprecated, use scan instead!');
		return await scanFromImageData(imageData);
	}

	// main

	applyOptions(options);
}

function getDefaultScannerDimensions(scannerFormat, canvasDimensions) {
	switch (scannerFormat) {
		case SCANNER_FORMATS.DATA_MATRIX:
			return { width: 250, height: 250 };
		case SCANNER_FORMATS.GS1_DATABAR_LIMITED_COMPOSITE:
			return { width: canvasDimensions.width, height: 250 };
		default:
			return { width: canvasDimensions.width, height: canvasDimensions.height };
	}
}

function getDefaultScannerOverlay(scannerFormat, scannerArea, canvasDimensions) {
	const scanerDimensions = {
		width: scannerArea[2],
		height: scannerArea[3]
	};

	const x = (canvasDimensions.width - size) / 2;
	const y = (canvasDimensions.height - size) / 2;

	const backgroundPoints = [
		{ x: canvasDimensions.width, y: 0 },
		{ x: canvasDimensions.width, y: canvasDimensions.height },
		{ x: 0, y: canvasDimensions.height },
		{ x: 0, y: 0 },
	];

	const holePoints = [
		{ x, y: y + scanerDimensions.height },
		{ x: x + scanerDimensions.width, y: y + scanerDimensions.height },
		{ x: x + scanerDimensions.width, y },
		{ x, y }
	];

	let overlayCanvas = document.createElement('canvas');
	overlayCanvas.width = canvasDimensions.width;
	overlayCanvas.height = canvasDimensions.height;

	let context = overlayCanvas.getContext("2d");

	context.beginPath();

	context.moveTo(backgroundPoints[0].x, backgroundPoints[0].y);
	for (let i = 0; i < 4; i++) {
		context.lineTo(backgroundPoints[i].x, backgroundPoints[i].y);
	}

	context.moveTo(holePoints[0].x, holePoints[0].y);
	for (let i = 0; i < 4; i++) {
		context.lineTo(holePoints[i].x, holePoints[i].y);
	}

	context.closePath();

	context.fillStyle = 'rgba(0, 0, 0, 0.5)'
	context.fill();

	context.lineWidth = 3;
	context.strokeStyle = 'rgb(0, 0, 0)';
	context.strokeRect(...scannerArea);

	return overlayCanvas;
}

async function timeout(time = 0) {
	return new Promise((resolve) => {
		const id = setTimeout(() => {
			clearTimeout(id)
			resolve();
		}, time)
	});
}

export default Scanner;
export { SCANNER_FORMATS };
