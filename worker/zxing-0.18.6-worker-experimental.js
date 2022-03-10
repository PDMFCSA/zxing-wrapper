const TAG = "[Scan Worker Experimental]";

addEventListener("message", async (message) => {
	let event = message.data;
	switch (event.type) {
		case "init":
			digestInit(event)
			break;
		case "decode":
			digestDecode(event);
			break;
		default:
			postMessage({ type: "unknown-message" });
	}
});

console.log(TAG, "Event listener set up!");

function decode(imageData, scannerFormat) {
	const {
		BrowserMultiFormatReader,
		HTMLCanvasElementLuminanceSource,
		BinaryBitmap,
		BarcodeFormat,
		HybridBinarizer
	} = ZXing;

	const hints = new Map();

	switch (scannerFormat) {
		case 1:
			// DATA_MATRIX
			hints.set(2, [BarcodeFormat.DATA_MATRIX]);
			break;
		case 2:
			// GS1_DATABAR_LIMITED_COMPOSITE
			// break;
		default:
			hints.set(3, true);
			break;
	}

	const canvasMock = {
		width: imageData.width,
		height: imageData.height,
		getContext: () => ({ getImageData: () => imageData }),
	};

	const luminanceSource = new HTMLCanvasElementLuminanceSource(canvasMock, imageData.width, imageData.height);
	const bitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
	const scanner = new BrowserMultiFormatReader(hints);
	return scanner.decodeBitmap(bitmap);
}

function digestInit(message) {
	let basePath = message.payload.basePath;

	importScripts(basePath + "../lib/zxing.min.js");
	importScripts(basePath + "filters.js");

	console.log(TAG, "Ready for requests!");
}

function digestDecode(message) {
	const { sendImageData } = message.payload;
	let { imageData, scannerFormat } = message.payload;

	try {
        let result;
        let lastError;

		for (let index in self.filters) {
			const filter = getFilter(self.filters[index]);
            let imageDataClone = self.cloneImageData(imageData);
			if (typeof filter === "function") {
				let newImageData = filter({ imageData: imageDataClone });

				try {
					result = decode(newImageData || imageDataClone, scannerFormat);
				} catch (error) {
					lastError = error;
					continue;
				}

                if (result) {
                    break;
                }
			}
		}

		if (!sendImageData) {
			imageData = [];
		}

		if (!result) {
			throw lastError;
		}

		postMessage({
			type: "decode-success",
			payload: {
				feedback: {imageData},
				result
			}
		});
	} catch (error) {
		if (error.name === "R" || error.name === "NotFoundException") {
			postMessage({
				type: "decode-fail",
				payload: {
					imageData,
					feedback: {imageData},
					error: {message: error.message}
				}
			});
		} else {
			console.log(error);
		}
	}
}
