/*
	This code was taken from https://github.com/cbrandolino/camvas and modified to suit our needs
*/
/*
Copyright (c) 2012 Claudio Brandolino

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
// The function takes a canvas context and a `drawFunc` function.
// `drawFunc` receives two parameters, the video and the time since
// the last time it was called.
function camvas(options) {
  var self = this
  this.callback = options.callback
  this.errorHandler = options.errorHandler || (err => console.error('camvas error: ' + err));
  this.loopRate = options.loopRate || 15;

  // We can't `new Video()` yet, so we'll resort to the vintage
  // "hidden div" hack for dynamic loading.
  var streamContainer = document.createElement('div')
  streamContainer.className = 'hidden-video-container';
  this.video = document.createElement('video')

  // If we don't do this, the stream will not be played.
  // By the way, the play and pause controls work as usual 
  // for streamed videos.
  this.video.setAttribute('autoplay', '1')
  this.video.setAttribute('playsinline', '1') // important for iPhones
  // this.video.setAttribute('muted', '1')
  

  // The video should fill out all of the canvas
  this.video.setAttribute('width', 1)
  this.video.setAttribute('height', 1)

  streamContainer.appendChild(this.video)
  document.body.appendChild(streamContainer)

  this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  this.analyser = this.audioCtx.createAnalyser()
  this.analyser.minDecibels = (options.minDecibels !== undefined) ? options.minDecibels : -90;
  this.analyser.maxDecibels = (options.maxDecibels !== undefined) ? options.maxDecibels : -10;
  this.analyser.smoothingTimeConstant = (options.smoothingTimeConstant !== undefined) ? options.smoothingTimeConstant : 0.85;
  this.analyser.fftSize = (options.fftSize !== undefined) ? options.fftSize : 256;
  this.byteTimeDomainData = new Uint8Array(this.analyser.fftSize)
  this.shouldResetStream = false
  this.allowStreamReset = true
  this.mediaChunks = []

  this.setStream = function(stream) {
    if (self.source && self.analyser) {
      self.source.disconnect(self.analyser)
    }
    if (self.stream) {
      self.stream.getTracks().forEach(track => track.stop());
    }
    self.stream = stream;
    self.source = self.audioCtx.createMediaStreamSource(stream)
    self.source.connect(self.analyser)
    // Yay, now our webcam input is treated as a normal video and
    // we can start having fun
    self.video.srcObject = stream
    self.video.muted = true

    if ((typeof MediaRecorder !== 'undefined') && !self.mediaRecorder) {
      // The media recorder uses only the first stream
      self.mediaRecorderStream = stream.clone();
      self.mediaRecorder = new MediaRecorder(self.mediaRecorderStream, { mimeType: options.mimeType })
      self.mediaRecorder.start()
  
      // If self.mediaChunks is set to a new value, the event listener will have no effect
      self.mediaRecorder.addEventListener('dataavailable', event => self.mediaChunks.push(event.data))  
    }
  }

  const mediaOptions = {
    // video: false,
    video: {
      facingMode: 'user',
      // width: 640,
      // height: 480,
    },
    audio: true
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Unsupported browser or device - getUserMedia is not implemented');
  }

  // The callback happens when we are starting to stream the video.
  navigator.mediaDevices.getUserMedia(mediaOptions).then(function(stream) {
    // Let's start drawing the canvas!
    self.setStream(stream)
    self.update()
  }, function(err) {
    self.errorHandler(err)
  });

  this.markShouldResetStream = function() {
    console.log('markShouldResetStream');
    self.shouldResetStream = self.allowStreamReset;
  };

  // As soon as we can draw a new frame on the canvas, we call the `draw` function 
  // we passed as a parameter.
  this.update = function() {
    const loop = async function() {
      if (self.shouldStopLoop) {
        self.shouldStopLoop = false;
        return;
      }
      try {
        self.callback(self.video, self.analyser, self.byteTimeDomainData)
        if (self.shouldResetStream) {
          console.info('resetting stream')
          self.shouldResetStream = false
          self.setStream(await navigator.mediaDevices.getUserMedia(mediaOptions))
        }
        requestAnimationFrame(loopTimeout);
      } catch (err) {
        self.errorHandler(err)
      }
    }
    const loopTimeout = function() {
      setTimeout(loop, self.loopRate);
    }
    requestAnimationFrame(loopTimeout)
  }
}
