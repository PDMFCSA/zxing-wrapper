const WORKER_SCRIPT_PATH = "worker/zxing-0.18.6-worker.js";
const SCAN_AREA_SIZE = 250;
const CANVAS_ID = "scene";

export default function Scanner(domElement, testMode) {

  let canvas;
  let context;
  let interval;
  let videoTag;
  let videoStream;
  let overlay;
  let worker;
  let workerPath = WORKER_SCRIPT_PATH;
  let scanAreaSize = SCAN_AREA_SIZE;
  let facingMode = "environment";

  let strokeColor = "#000000";

  this.setup = async (options = {}) => {
    if (!options) {
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
      await connectCamera(options.deviceId);
    }
  }

  this.getCameras = async (facingMode) => {
    let verifyConstraints = function (capabilities) {
      let result = true;
      if (facingMode) {
        if (capabilities.facingMode &&
          Array.isArray(capabilities.facingMode) &&
          capabilities.facingMode.length > 0 &&
          capabilities.facingMode.indexOf(facingMode) === -1) {
          result = false;
        }
      }
      return result;
    }

    //force user permission request
    //this fixes an issue on ios: if enumerateDevices is called before user grants permission
    //the number of returned devices is short (some devices are missing)
    let stream = await navigator.mediaDevices.getUserMedia({
      video: true
    });
    let track = stream.getVideoTracks()[0];
    //we need to ensure that no camera remains active
    track.stop();

    //if we get to this point... we have user permissions, and we can go on detecting the cameras
    let cameras = [];
    let listNeedsSorting = false;
    let devices = await navigator.mediaDevices.enumerateDevices();

    for (let i = 0; i < devices.length; i++) {
      let device = devices[i];
      if (device.kind === 'videoinput') {
        let stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: device.deviceId
          }
        });
        let track = stream.getVideoTracks()[0];
        let cameraCapabilities = track.getCapabilities();
        cameraCapabilities.index = i;

        //we need to ensure that no camera remains active
        track.stop();

        if (verifyConstraints(cameraCapabilities)) {
          //if the flag was not set to true, and we found information about focusMode
          if (!listNeedsSorting && cameraCapabilities.focusMode) {
            listNeedsSorting = true;
          }
          cameras.push({id: device.deviceId, label: device.label, cameraCapabilities});
        }
      }
    }

    //before returning the camera's list we need to put in front the camera with the best changes of being the right one
    //at this point in time, we believe that if we find multiple camera we should prioritize the one with focusMode continuous
    if (listNeedsSorting && cameras.length > 1) {
      cameras.sort((a, b) => {
        let aFocusMode = a.cameraCapabilities.focusMode;
        aFocusMode = aFocusMode && Array.isArray(aFocusMode) && aFocusMode.indexOf("continuous") !== -1;

        let bFocusMode = b.cameraCapabilities.focusMode;
        bFocusMode = bFocusMode && Array.isArray(bFocusMode) && bFocusMode.indexOf("continuous") !== -1;

        if (aFocusMode === bFocusMode && aFocusMode === true) {
          //both cameras have focusMode continuous
          return 0;
        }

        if (aFocusMode && !bFocusMode) {
          //camera "a" has focusMode continuous
          return -1;
        }

        if (!aFocusMode && bFocusMode) {
          //camera "b" has focusMode continuous
          return 1;
        }
      });
    }
    return cameras;
  }

  this.shutDown = async () => {
    reset();

    if (worker) {
      worker.terminate();
    }

    if (domElement.children.length) {
      domElement.innerHTML = "";
    }
  }

  this.scan = async () => {
    let frame = getDataForScanning();
    let result = await decode(frame);
    if (result) {
      strokeColor = "#008000";
    } else {
      strokeColor = "#000000";
    }
    return result;
  }

  this.scanImageData = async (imageData) => {
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

  this.changeWorker = (path) => {
    workerPath = path;
  }

  this.setScanAreaSize = (size) => {
    scanAreaSize = size;
  }

  this.drawOverlay = (centerArea, canvasDimensions) => {
    let size = centerArea[3];
    const {width, height} = canvasDimensions;

    const x = (width - size) / 2;
    const y = (height - size) / 2;

    const backgroundPoints = [
      {x: width, y: 0},
      {x: width, y: height},
      {x: 0, y: height},
      {x: 0, y: 0},
    ];

    const holePoints = [
      {x, y: y + size},
      {x: x + size, y: y + size},
      {x: x + size, y},
      {x, y}
    ];

    let overlayCanvas = canvas.cloneNode();
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

    drawCenterArea(context);

    return overlayCanvas;
  }

  this.listVideoInputDevices = async () => {
    if (!window.navigator) {
      throw new Error("Can't enumerate devices, navigator is not present.");
    }

    if (!window.navigator.mediaDevices && typeof window.navigator.mediaDevices.enumerateDevices !== 'function') {
      throw new Error("Can't enumerate devices, method not supported.");
    }

    const devices = await window.navigator.mediaDevices.enumerateDevices();

    const videoDevices = [];
    for (const device of devices) {
      const {kind} = device;
      if (kind !== 'videoinput') {
        continue;
      }
      const deviceId = device.deviceId;
      const label = device.label || `Video device ${videoDevices.length + 1}`;
      const groupId = device.groupId;
      const videoDevice = {deviceId, label, kind, groupId};
      videoDevices.push(videoDevice);
    }
    return videoDevices;
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
        console.log("Caught an error during video track stop process.", err);
      }
    }

    if (interval) {
      clearInterval(interval);
    }
  }

  const internalSetup = () => {
    let id = CANVAS_ID;
    if (!domElement.querySelector("#" + id)) {
      canvas = document.createElement("canvas");
      canvas.id = id;

      context = canvas.getContext("2d", {willReadFrequently: true});

      context.imageSmoothingEnabled = false;

      canvas.setAttribute("style", "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);");
      domElement.style.position = 'absolute';
      domElement.style.top = 0;
      domElement.style.bottom = 0;
      domElement.append(canvas);
    }
  }

  const getCenterArea = () => {
    let {width, height} = canvas;
    let size = Math.min(Math.min(window.innerWidth, window.innerHeight) * 0.8, 350);
    const points = [(width - size) / 2, (height - size) / 2, size, size];
    return points;
  }

  const decode = (imageData) => {
    let promise = new Promise((resolve, reject) => {
      let segments = workerPath.split("/");
      let fileName = segments.pop();
      let basePath = segments.join("/") + segments.length > 1 ? "/" : "";

      if (!worker) {
        worker = new Worker(workerPath);
        worker.postMessage({
          type: "init",
          payload: {
            basePath
          }
        });
      }

      let waitFor = (message) => {
        try {
          //verify message
          let result;
          let event = message.data;
          let messageType = event.type;
          switch (messageType) {
            case "decode-fail":
              //console.log("got an message with failed decoding status");
              break;
            case "decode-success":
              result = event.payload.result;
              break;
            default:
              console.log("Caught a strange message");
              result = event;
          }

          worker.removeEventListener("message", waitFor);
          worker.removeEventListener("error", errorHandler);
          resolve(result);
        } catch (err) {
          console.log(err);
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
          imageData,
          filterId: ""
        }
      });
    });

    return promise;
  }

  const connectCamera = async (deviceId) => {
    return new Promise(async (resolve, reject) => {
      let stream;
      let constraints = {
        audio: false,
        video: {facingMode},
        advanced: [{focusMode: "continuous"}]
      };

      if (deviceId) {
        //if we are called with a deviceId we ignore any video constraints set with facing mode
        constraints.video = {deviceId};
      }

      try {
        stream = await window.navigator.mediaDevices.getUserMedia(constraints);
        const track = stream.getVideoTracks()[0];
        //const capabilities = track.getCapabilities();
        //console.log(capabilities);

        constraints.video.height = 1080;
        constraints.video.width = 1920;

        await track.applyConstraints(constraints.video);
      } catch (error) {
        console.log("Caught an error during camera connection", error);
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
        interval = setInterval(drawFrame, 30);
        resolve(true);
      });
      video.addEventListener("error", (e) => reject(e.error));

      videoTag = video;
      videoStream = stream;

      video.srcObject = stream;

      // enable autoplay video for Safari desktop and mobile
      if (!gotFullSupport()) {
        domElement.append(video);
      }
    });
  }

  const getDataForScanning = () => {
    let frameAsImageData = context.getImageData(...getCenterArea());

    if (testMode) {
      this.lastScanInput = frameAsImageData;
      this.lastFrame = context.getImageData(0, 0, canvas.width, canvas.height);
    }

    return frameAsImageData;
  }

  const drawCenterArea = (context) => {
    context.lineWidth = 3;
    context.strokeStyle = strokeColor;
    const centerAreaPoints = getCenterArea();
    context.strokeRect(...centerAreaPoints);
  }

  const drawFrame = async (frame) => {
    const {width, height} = canvas;

    if (!overlay) {
      overlay = this.drawOverlay(getCenterArea(), {width, height});
      domElement.append(overlay || null);
    }

    //context.filter = 'brightness(1.75) contrast(1) grayscale(1)';
    if (!frame) {
      frame = await grabFrameFromStream();
    }

    if (!frame) {
      console.log("Dropping frame");
      return;
    }

    context.drawImage(frame, 0, 0, width, height);
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
      console.log("Got a situation during grabFrame from stream process.", err);
    }
    return frame;
  }

  const gotFullSupport = () => {
    return !!window.ImageCapture && !!window.ImageCapture.prototype?.grabFrame;
    //return false;
  }

  const grabFrameAlternative = () => {
    let tempCanvas = document.createElement("canvas");
    let tempContext = tempCanvas.getContext("2d");
    let {width, height} = canvas;
    tempCanvas.width = width;
    tempCanvas.height = height;

    tempContext.drawImage(videoTag, 0, 0, width, height);
    return tempCanvas;
  }
}
