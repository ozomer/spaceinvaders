/*
  spaceinvaders.js

  the core logic for the space invaders game.

*/

/*  
    Game Class

    The Game class represents a Space Invaders game.
    Create an instance of it, change any of the default values
    in the settings, and call 'start' to run the game.

    Call 'initialise' before 'start' to set the canvas the game
    will draw to.

    Call 'moveShip' or 'shipFire' to control the ship.

    Listen for 'gameWon' or 'gameLost' events to handle the game
    ending.
*/

//  Constants for the keyboard.
// const KEY_SPACE = 32;

const skipGame = /skip-game/.test(window.location.hash); // fo testing

const initialLives = skipGame ? 0 : 5; // for testing

const LEFT_POSE = 0;
const CENTER_POSE = 1;
const RIGHT_POSE = 2;

function rgbaToGrayscale(rgba, nrows, ncols) {
  var gray = new Uint8Array(nrows*ncols);
  for(var r=0; r<nrows; ++r)
    for(var c=0; c<ncols; ++c)
      // gray = 0.2*red + 0.7*green + 0.1*blue
      gray[r*ncols + c] = (2*rgba[r*4*ncols+4*c+0]+7*rgba[r*4*ncols+4*c+1]+1*rgba[r*4*ncols+4*c+2])/10;
  return gray;
}

function diversityChecker() {
  return {
    counters: Array.from({ length: 256 }, () => 0),
    diversity: 0
  };
}

//  Creates an instance of the Game class.
function Game(gameWidth, gameHeight) {
  //  Set the initial config.
  this.config = {
    bombRate: 0.05,
    bombMinVelocity: Math.floor(0.4 * gameWidth),
    bombMaxVelocity: Math.floor(0.4 * gameWidth),
    invaderInitialVelocity: Math.floor(0.17 * gameWidth),
    invaderAcceleration: 0.05,
    invaderDropDistance: Math.floor(0.0375 * gameWidth),
    rocketVelocity: Math.floor(1.2 * gameWidth),
    rocketMaxFireRate: 20,
    gameWidth: gameWidth,
    gameHeight: gameHeight,
    fps: 30,
    debugMode: false,
    invaderRanks: 3,
    invaderFiles: 6,
    shipSpeed: Math.floor(0.3 * gameWidth),
    levelDifficultyMultiplier: 0.4,
    pointsPerInvader: 5,
    imageSampleFrameRate: 200,
    detectionScoreLimit: 15,
    noDetectionTimeLimit: 3,
  };

  //  All state is in the variables below.
  this.lives = initialLives;
  this.width = 0; // canvas
  this.height = 0; // canvas
  this.gameBounds = {left: 0, top: 0, right: 0, bottom: 0};
  this.intervalId = 0;
  this.score = 0;
  this.level = 1;

  //  The state stack.
  this.stateStack = [];

  //  Input/output
  this.pressedKeys = {};
  this.gameCanvas =  null;

  //  All sounds.
  // this.sounds = null;
  this.images = null;

  // this.webcamInitialized = false;
  this.imageSamples = null; // will be an array if needs to be filled
  this.angles = [0].map(angle => angle * Math.PI / 180);
  this.pose = CENTER_POSE;
  this.highVolume = false;
  this.voiceCommandFlag = false;

  this.videoWidth = 1;
  this.videoHeight = 1;
}

//  Initialis the Game with a canvas.
Game.prototype.initialise = function(gameCanvas) {
  //  Set the game canvas.
  this.gameCanvas = gameCanvas;

  //  Set the game width and height.
  this.width = gameCanvas.width;
  this.height = gameCanvas.height;

  //  Set the state game bounds.
  this.gameBounds = {
    left: gameCanvas.width / 2 - this.config.gameWidth / 2,
    right: gameCanvas.width / 2 + this.config.gameWidth / 2,
    top: gameCanvas.height / 2 - this.config.gameHeight / 2,
    bottom: gameCanvas.height / 2 + this.config.gameHeight / 2,
  };
  
  const self = this;
  gameCanvas.addEventListener('click', e => {
    self.click(e.offsetX, e.offsetY);
  });

  this.canvases = this.angles.map((angle, index) => {
    const element = document.createElement('canvas');
    element.width = 1;
    element.height = 1;
    element.className = 'recording-canvas';
    return {
      element: element,
      angle: angle,
      context: element.getContext('2d'),
      index: index,
    };
  });
  this.canvases.forEach((canvas) => {
    canvas.context.translate(Math.floor(canvas.element.width / 2), Math.floor(canvas.element.height / 2));
    canvas.context.rotate(canvas.angle);
    canvas.context.translate(-Math.floor(canvas.element.width / 2), -Math.floor(canvas.element.height / 2));
    document.getElementById('canvasescontainer').appendChild(canvas.element);
  });
  this.mainRecordingCanvas = this.canvases.filter(canvas => canvas.angle === 0)[0];

  this.updateMemory = pico.instantiateDetectionMemory(5); // we will use the detecions of the last 5 frames
  this.facefinderClassifyRegion = function(r, c, s, pixels, ldim) {return -1.0;};
  this.doPuploc = function(r, c, s, nperturbs, pixels, nrows, ncols, ldim) {return [-1.0, -1.0];};
  
  this.lastVoiceSample = 0;
  this.lastAngleSample = 0;
  this.lastImageSample = 0;

  this.lastDiverseVoiceSample = null;
  this.voiceDiversityChecker = diversityChecker();
  this.medianVolumeCollector = [];
  this.medianVolume = Infinity;

  this.camvasInitState = null;

  this.images = {
    alien1: imageFromSrc('images/alien1.svg'),
    alien2: imageFromSrc('images/alien2.svg'),
    alien3: imageFromSrc('images/alien3.svg'),
    alien4: imageFromSrc('images/alien4.svg'),
    alienFace: imageFromSrc('images/alien_face.svg'),
  };
};

Game.prototype.fetchFaceDetectionBins = function() {
  const self = this;
  return Promise.all([
    (async () => {
      const response = await fetch('bin/facefinder');
      if (!response.ok) {
        console.error(response);
        throw new Error('Failed to fetch facefinder');
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Int8Array(buffer);
      self.facefinderClassifyRegion = pico.unpackCascade(bytes);
      console.log('* facefinder loaded');
    })(),
    (async () => {
      const response = await fetch('bin/puploc.bin');
      if (!response.ok) {
        console.error(response);
        throw new Error('Failed to fetch puploc.bin');
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Int8Array(buffer);
      self.doPuploc = lploc.unpackLocalizer(bytes);
      console.log('* puploc loaded');
    })(),
  ]);
}

Game.prototype.handleCamvasFailure = function(err) {
  console.error(err);
  this.camvasInitState = 'FAIL';
  if (this.camvasInitTimeout) {
    clearTimeout(this.camvasInitTimeout);
    this.camvasInitTimeout = null;
  }
  if (!this.currentState() || !(this.currentState() instanceof FailState)) {
    this.moveToState(new FailState(err));
  }
};

Game.prototype.handleCamvasSuccess = function() {
  const self = this;
  this.camvasInitState = 'SUCCESS';
  if (this.camvasInitTimeout) {
    clearTimeout(this.camvasInitTimeout);
    this.camvasInitTimeout = null;
  }
  this.medianVoiceInterval = setInterval(() => {
    if (self.medianVolumeCollector.length > 0) {
      self.medianVolume = self.medianVolumeCollector.sort((a, b) => a - b)[Math.floor(self.medianVolumeCollector.length / 2)];
      console.log('medianVolume: ' + self.medianVolume);
      self.medianVolumeCollector = [];
    }
  }, 4e3);
};

Game.prototype.initCamvas = function() {
  if (this.camvasInitState) {
    return;
  }

  this.camvasInitState = 'START';
  /*
    (5) instantiate camera handling (see https://github.com/cbrandolino/camvas)
  */
  try {
    // runs async process
    this.mainCamvas = new camvas({
      callback: this.processVideo.bind(this),
      errorHandler: this.handleCamvasFailure.bind(this),
      mimeType: 'video/webm',
    });
    if (this.mainCamvas.mediaRecorder) {
      this.mediaRecorderOutputType = 'video/webm';
      this.mediaRecorderFilenameExtension = 'webm';  
    } else {
      this.imageSamples = [];
    }
  } catch (err) {
    this.handleCamvasFailure(err);
    return;
  }
  
  const self = this;
  this.camvasInitTimeout = setTimeout(() => {
    self.camvasInitTimeout = null;
    self.handleCamvasFailure(new Error('Timeout'));
  }, 8e3);
};

Game.prototype.processVideo = function(video, dt, analyser, byteTimeDomainData) {
  const now = Date.now();
  const self = this;
  if (analyser && (now - this.lastVoiceSample > 50)) {
    analyser.getByteTimeDomainData(byteTimeDomainData);
    // volumeElement.value = Math.max(...byteTimeDomainData.map(v => Math.abs(v - 128)));
    self.lastVoiceSample = now;
    if (byteTimeDomainData.some((b) => {
      self.voiceDiversityChecker.counters[b] += 1;
      if (self.voiceDiversityChecker.counters[b] === 2) {
        self.voiceDiversityChecker.diversity += 1;
      }
      return self.voiceDiversityChecker.diversity > 1;
    })) {
      self.voiceDiversityChecker = diversityChecker();
      self.lastDiverseVoiceSample = now;
      if (self.camvasInitState === 'START') {
        self.handleCamvasSuccess();
      }
    } else if (self.lastDiverseVoiceSample && ((now - self.lastDiverseVoiceSample > 4e3))) {
      self.lastDiverseVoiceSample = null;
      self.mainCamvas.markShouldResetStream();
    }
    const absVolumes = byteTimeDomainData.map(sample => Math.abs(sample - 128));
    // self.medianVolumeCollector.push(absVolumes.sort((a, b) => a - b)[Math.floor(absVolumes.length / 2)]);
    // const maxVolume = Math.sqrt(absVolumes.reduce((soFar, v) => (soFar + v**2), 0) / absVolumes.length);
    const maxVolume = Math.max(...absVolumes);
    self.medianVolumeCollector.push(maxVolume);

    const isVolumeHigh = (maxVolume > Math.max(self.medianVolume, 2) * 2);
    if (isVolumeHigh && !self.highVolume) {
      console.log('volumeUp: ' + maxVolume);
      self.volumeUp();
      self.highVolume = true;
    } else if (!isVolumeHigh && self.highVolume) {
      self.volumeDown();
      self.highVolume = false;
    }
  }

  if (video.videoWidth && (video.videoWidth !== this.videoWidth)) {
    console.info('setting game width from ' + this.videoWidth + ' to ' + video.videoWidth);
    this.videoWidth = video.videoWidth;
  }
  if (video.videoHeight && (video.videoHeight !== this.videoHeight)) {
    console.info('setting game height from ' + this.videoHeight + ' to ' + video.videoHeight);
    this.videoHeight = video.videoHeight;
  }
  
  const results = this.canvases.map((canvas) => {
    let canvasChanged = false;
    if (video.videoWidth && (video.videoWidth !== canvas.element.width)) {
      console.info('setting video canvas ' + canvas.index + ' width from ' + canvas.element.width + ' to ' + video.videoWidth);
      canvas.element.width = video.videoWidth;
      canvasChanged = true;
    }
    if (video.videoHeight && (video.videoHeight !== canvas.element.height)) {
      console.info('setting video canvas ' + canvas.index + ' height from ' + canvas.element.height + ' to ' + video.videoHeight);
      canvas.element.height = video.videoHeight;
      canvasChanged = true;
    }
    if (canvasChanged) {
      canvas.context.setTransform(1, 0, 0, 1, 0, 0); // reset transformation
      canvas.context.translate(Math.floor(canvas.element.width / 2), Math.floor(canvas.element.height / 2));
      canvas.context.rotate(canvas.angle);
      canvas.context.translate(-Math.floor(canvas.element.width / 2), -Math.floor(canvas.element.height / 2));
      // canvasDimensionsElement.innerText = '' + canvas.element.width + 'x' + canvas.element.height;
    }
    // render the video frame to the canvas element and extract RGBA pixel data
    canvas.context.globalAlpha = 1;
    canvas.context.drawImage(video, 0, 0, canvas.element.width, canvas.element.height);
    const imageData = canvas.context.getImageData(0, 0, canvas.element.width, canvas.element.height);
    if (self.imageSamples && (canvas === self.mainRecordingCanvas) && (now - self.lastImageSample > self.config.imageSampleFrameRate)) {
      self.lastImageSample = now;
      self.imageSamples.push(imageData);
      if (self.imageSamples.length > 1200) {
        // keep only last 2 minutes (for frame rate 200)
        self.imageSamples.splice(0, self.imageSamples.length - 600);
      }
    }
    // prepare input to `runCascade`
    const image = {
      "pixels": rgbaToGrayscale(imageData.data, canvas.element.height, canvas.element.width),
      "nrows": canvas.element.height,
      "ncols": canvas.element.width,
      "ldim": canvas.element.width
    }
    const params = {
      "shiftfactor": 0.1, // move the detection window by 10% of its size
      "minsize": 100,     // minimum size of a face
      "maxsize": 1000,    // maximum size of a face
      "scalefactor": 1.1  // for multiscale processing: resize the detection window by 10% when moving to the higher scale
    }
    // run the cascade over the frame and cluster the obtained detections
    // dets is an array that contains (r, c, s, q) quadruplets
    // (representing row, column, scale and detection score)
    const dets = pico.clusterDetections(
      self.updateMemory(pico.runCascade(image, self.facefinderClassifyRegion, params)),
      0.2 // set IoU threshold to 0.2
    );

    if (dets.length === 0) {
      return {
        score: -Infinity
      };
    }

    const bestScoreDet = dets
    .map(det => ({
      det: det,
      score: det[3],
    }))
    .reduce((soFar, newValue) => ((soFar.score < newValue.score) ? newValue : soFar));
    return {
      det: bestScoreDet.det,
      score: bestScoreDet.score,
      canvas: canvas,
      image: image,
    };
  }); // some results may be have score -Infinity

  /*
  const bestResult = results.reduce((soFar, newValue) => {
    if (!soFar) {
      return newValue;
    }
    if (!newValue) {
      return soFar;
    }
    return (soFar.score < newValue.score) ? newValue : soFar;
  });
  */

  if (results.some(result => result.det)) {
    const bestResults = results.filter(result => result && (result.score > self.config.detectionScoreLimit));
    if (bestResults.length > 0) {
      // const scoreText = (bestResults.map(result => result.score).reduce(sum) / bestResults.length).toFixed(0).padStart(3, '0');
      // scoreElement.value = scoreText + ' / ' + scoreText;
      // scoreElement.setAttribute('data-lastGoodScore', scoreText);
      if (now - this.lastAngleSample > 100) {
        // const bestScore = Math.max(...bestResults.map(result => result.score));
        const angleScores = results
        .map((result) => {
          if (!result.det) {
            return {
              score: result.score,
              angle: NaN,
            };
          }
          let firstX, firstY, secondX, secondY;
          //
          // find the eye pupils for each detected face
          // starting regions for localization are initialized based on the face bounding box
          // (parameters are set empirically)
          // first eye
          const r = result.det[0] - 0.075*result.det[2];
          const s = 0.35*result.det[2];
          const c1 = result.det[1] - 0.175*result.det[2];
          [firstY, firstX] = self.doPuploc(r, c1, s, 63, result.image)
          // second eye
          // r = result.det[0] - 0.075*result.det[2];
          const c2 = result.det[1] + 0.175*result.det[2];
          // s = 0.35*result.det[2];
          [secondY, secondX] = self.doPuploc(r, c2, s, 63, result.image)
          /*
          if(secondY>=0 && secondX>=0)
          {
            ctx.beginPath();
            ctx.arc(secondX, secondY, 1, 0, 2*Math.PI, false);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'blue';
            ctx.stroke();
          }
          */
          // Remember that Y axis is transposed
          return {
            score: result.score,
            angle: (Math.atan((secondY - firstY) / (secondX - firstX)) - result.canvas.angle) * 180 / Math.PI,
          };
        });
        // const closeToBest = 0.95;
        // angleElement.value = angleScores.map(angleScore => (angleScore.score > self.config.detectionScoreLimit ? angleScore.angle.toFixed(0) : '_').padStart(3, ' ') + ((angleScore.score >= bestScore * closeToBest) ? '*' : ' ')).join(', ');
        // const goodAngleScores = angleScores.filter(angleScore => angleScore.score > self.detectionScoreLimit);
        // const angle = goodAngleScores.map(angleScore => angleScore.angle).reduce(sum) / goodAngleScores.length;
        const angle = angleScores.reduce((as1, as2) => (as1.score > as2.score ? as1 : as2)).angle;
        // const goodAngles = goodAngleScores.filter(as => as.score > bestScore * closeToBest).map(as => as.angle).sort((a, b) => a - b);
        // const angle = (goodAngles[Math.floor((goodAngles.length - 1) / 2)] + goodAngles[Math.ceil((goodAngles.length - 1) / 2)]) / 2;
        // poseElement.value = angle.toFixed(0).padEnd(4, ' ') + ['left', 'center', 'right'][(angle < 12) + (angle < -12)];
        // canvasIndexElement.value = bestResults.map(result => result.canvas.index).join(', ');
        this.pose = [LEFT_POSE, CENTER_POSE, RIGHT_POSE][(angle < 12) + (angle < -12)];
        this.lastAngleSample = now;
      }
    }
    // else {
      // const score = Math.max(...results.map(result => result.score));
      // check the detection score
      // if it's above the threshold, draw it
      // (the constant 50.0 is empirical: other cascades might require a different one)
      // const scoreText = score.toFixed(0).padStart(3, '0');
      // scoreElement.value = scoreText + ' / ' + (scoreElement.getAttribute('data-lastGoodScore') || '');
    // }
  }
}

Game.prototype.moveToState = function(state) {
   //  If we are in a state, leave it.
   if(this.currentState() && this.currentState().leave) {
     this.currentState().leave(game);
     this.stateStack.pop();
   }
   
   //  If there's an enter function for the new state, call it.
   if(state.enter) {
     state.enter(game);
   }
 
   //  Set the current state.
   this.stateStack.pop();
   this.stateStack.push(state);
 };

//  Start the Game.
Game.prototype.start = function() {
  
  //  Move into the 'welcome' state.
  this.moveToState(new WelcomeState());
  
  //  Set the game variables.
  this.lives = initialLives;
  this.lastHit = 0;
  this.config.debugMode = /debug=true/.test(window.location.hash);
  
  //  Start the game loop.
  const self = this;
  let lastTime = new Date();
  this.intervalId = setInterval(function () {
    const now = Date.now();
    GameLoop(self, now, (now - lastTime) / 1000);
    lastTime = now;
  }, 1000 / this.config.fps);
};

//  Returns the current state.
Game.prototype.currentState = function() {
    return this.stateStack.length > 0 ? this.stateStack[this.stateStack.length - 1] : null;
};

//  Mutes or unmutes the game.
/*
Game.prototype.mute = function(mute) {

    //  If we've been told to mute, mute.
    if(mute === true) {
        this.sounds.mute = true;
    } else if (mute === false) {
        this.sounds.mute = false;
    } else {
        // Toggle mute instead...
        this.sounds.mute = this.sounds.mute ? false : true;
    }
};
*/

//  The main loop.
function GameLoop(game, now, dt) {
  var currentState = game.currentState();
  if (currentState) {
    //  Delta t is the time to update/draw.
    // var dt = 1 / game.config.fps;
    
    //  Get the drawing context.
    const ctx = this.gameCanvas.getContext("2d");
    
    //  Update if we have an update function. Also draw
    //  if we have a draw function.
    if (currentState.update) {
      currentState.update(game, now, dt);
    }
    if (currentState.draw) {
      currentState.draw(ctx, game, now, dt);
    }
  }
}

Game.prototype.pushState = function(state) {

    //  If there's an enter function for the new state, call it.
    if(state.enter) {
        state.enter(game);
    }
    //  Set the current state.
    this.stateStack.push(state);
};

Game.prototype.popState = function() {

    //  Leave and pop the state.
    if(this.currentState()) {
        if(this.currentState().leave) {
            this.currentState().leave(game);
        }

        //  Set the current state.
        this.stateStack.pop();
    }
};

//  The stop function stops the game.
Game.prototype.stop = function Stop() {
    clearInterval(this.intervalId);
};

//  Inform the game
Game.prototype.click = function(x, y) {
  //  Delegate to the current state too.
  if(this.currentState() && this.currentState().click) {
    this.currentState().click(this, x, y);
  }
};

//  Inform the game a key is down.
Game.prototype.keyDown = function(keyCode) {
  this.pressedKeys[keyCode] = true;
  const currentState = this.currentState();
  //  Delegate to the current state too.
  if (currentState && currentState.keyDown) {
    currentState.keyDown(this, keyCode);
  }
};

//  Inform the game a key is up.
Game.prototype.keyUp = function(keyCode) {
  delete this.pressedKeys[keyCode];
  //  Delegate to the current state too.
  const currentState = this.currentState();
  if (currentState && currentState.keyUp) {
    currentState.keyUp(this, keyCode);
  }
};

Game.prototype.volumeUp = function() {
  const currentState = this.currentState();
  if( currentState && currentState.volumeUp) {
    currentState.volumeUp(this);
  }
}

Game.prototype.volumeDown = function() {
  const currentState = this.currentState();
  if( currentState && currentState.volumeDown) {
    currentState.volumeDown(this);
  }
}

function imageFromSrc(src) {
  const image = new Image();
  image.src = src;
  return image;
}

function WelcomeState() {
  this.loadingState = null;
}


WelcomeState.prototype.enter = function(game) {
  // Create and load the sounds.
  // game.sounds = new Sounds();
  // game.sounds.init();
  // game.sounds.loadSound('shoot', 'sounds/shoot.wav');
  // game.sounds.loadSound('bang', 'sounds/bang.wav');
  // game.sounds.loadSound('explosion', 'sounds/explosion.wav');
  
  const self = this;  
  game.fetchFaceDetectionBins()
  .then(() => {
    self.loadingState = 'SUCCESS';
  })
  .catch(() => {
    self.loadingState = 'FAIL';
  });
};

WelcomeState.prototype.update = function(game, now, dt) {
  if ((game.camvasInitState === 'SUCCESS') && (game.medianVolume < Infinity)) {
    game.moveToState(new TutorialState(game.config));
  }
};

WelcomeState.prototype.draw = function(ctx, game, now, dt) {
  //  Clear the background.
  ctx.clearRect(0, 0, game.width, game.height);
  
  const lineHeight = Math.floor(0.09 * game.width);
  
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline="middle"; 
  ctx.textAlign="right";
  ctx.font='' + Math.floor(0.04 * game.width) + "px Arial";
  ctx.fillText("Credits & Help", game.width * 0.95, 0.04 * game.width);

  ctx.textBaseline="middle"; 
  ctx.textAlign="center"; 
  ctx.font='' + Math.floor(0.09 * game.width) + "px Arial";
  ctx.fillText("Space Invaders", game.width / 2, lineHeight * 2);
  ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
  ctx.fillText("with", game.width / 2, lineHeight * 3); 
  ctx.font='' + Math.floor(0.09 * game.width) + "px Arial";
  ctx.fillText("Artificial Intelligence", game.width / 2, lineHeight * 4);
  ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
  if (this.loadingState !== 'FAIL') {
    ctx.fillText("This game uses face detection.", game.width / 2, game.height/2, game.width);
    ctx.fillText("Please allow camera access.", game.width / 2, game.height/2 + lineHeight, game.width);  
  } else {
    ctx.fillText("Failed to load resources.", game.width / 2, game.height/2, game.width);
    ctx.fillText("Please try to reload the page.", game.width / 2, game.height/2 + lineHeight, game.width);
  }
  if (!game.camvasInitState) {
    if (this.loadingState !== 'FAIL') {
      ctx.font='bold ' + Math.floor(0.09 * game.width) + "px Arial";
      ctx.fillText(this.loadingState === 'SUCCESS' ? 'CONTINUE' : 'Loading...', game.width / 2, game.height - Math.floor(0.18 * game.width));
    }
  } else {
    ctx.font='bold ' + Math.floor(0.06 * game.width) + "px Arial";
    ctx.fillText('Initializing Game...', game.width / 2, game.height - Math.floor(0.18 * game.width));
  }
};

WelcomeState.prototype.click = function(game, x, y) {
  if ((y < 0.08 * game.width) && (x > 0.7 * game.width)) {
    window.location.href = 'credits.html';
  }
  if ((this.loadingState === 'SUCCESS') && (game.height - 0.225 * game.width < y) && (y < game.height - 0.15 * game.width)) {
    game.initCamvas();
  }
};

function FailState(err) {
  this.err = err;
  this.showError = false;
  this.clicks = [];
}

FailState.prototype.enter = function(game) {
};

FailState.prototype.click = function(x, y) {
  const now = Date.now();
  this.clicks.push(now - 5);
  while (this.clicks[0] < now - 5e3) {
    this.clicks.shift();
  }
  console.log('clicks in the last 5 seconds: ' + this.clicks.length);
  if (this.clicks.length >= 10) {
    this.showError = !this.showError;
    console.log('showError: ' + this.showError);
    this.clicks = [];
  }
}

FailState.prototype.update = function(game, now, dt) {
};

FailState.prototype.draw = function(ctx, game, now, dt) {
  //  Clear the background.
  ctx.clearRect(0, 0, game.width, game.height);

  if (this.showError) {
    ctx.textBaseline="top"; 
    ctx.textAlign="left"; 
    ctx.fillStyle = '#ffffff';
    ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
    const errorText = ('' + this.err + (this.err.stack ? ' ' + this.err.stack : '')).replace(/\n/g, ' ');
    for (let line = 0; line < Math.ceil(errorText.length / 40); line += 1) {
      ctx.fillText(errorText.slice(line * 40, (line + 1) * 40), 0, Math.floor(0.06 * game.width * (line + 1)), game.width);
    }
  } else {
    const lineHeight = Math.floor(0.09 * game.width);
    ctx.textBaseline="middle"; 
    ctx.textAlign="center"; 
    ctx.fillStyle = '#ffffff';
    ctx.font='' + Math.floor(0.09 * game.width) + "px Arial";
    ctx.fillText("Initialization Failed", game.width / 2, lineHeight * 2);
    ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
    ctx.textAlign="left"; 
    ctx.fillText("Please refresh the page and", game.width * 0.05, game.height/2 - lineHeight * 3, game.width * 0.9);
    ctx.fillText("allow camera & microphone access.", game.width * 0.05, game.height/2 - lineHeight * 2, game.width * 0.9);
    ctx.fillText("Make sure that your microphone is", game.width * 0.05, game.height/2 - lineHeight * 1, game.width * 0.9);
    ctx.fillText("not muted.", game.width * 0.05, game.height/2 + lineHeight * 0, game.width * 0.9);
    ctx.fillText("iPhone Users: You must open the", game.width * 0.05, game.height/2+ lineHeight * 1, game.width * 0.9);
    ctx.fillText("page in Safari.", game.width * 0.05, game.height/2 + lineHeight * 2, game.width * 0.9);
    ctx.fillText("Android Users: Try using Chrome.", game.width * 0.05, game.height/2 + lineHeight * 3, game.width * 0.9);  
  }
};

function TutorialState(config) {
  this.timeProgress = 0;
  this.noDetectionTime = 0;
  this.warnProgress = null;
  this.lastRocketTime = null;
  this.config = config;
}

TutorialState.prototype.enter = function(game) {
  this.ship = new Ship(game, game.width / 2, Math.floor(game.gameBounds.bottom - 0.0275 * game.width));
  this.shipSpeed = game.config.shipSpeed;
  this.invaders = skipGame ? [] : [{
    invader: new Invader(game, Math.floor((game.gameBounds.left * 7 + game.gameBounds.right) / 8), game.height / 2 + (0.27 * game.width), 0, 0, 'Invader'),
    velocity: game.config.invaderInitialVelocity,
    left: game.gameBounds.left,
    right: (game.gameBounds.left * 3 + game.gameBounds.right) / 4,
  }, {
    invader: new Invader(game, Math.floor((game.gameBounds.left + game.gameBounds.right * 7) / 8), game.height / 2 + (0.27 * game.width), 0, 0, 'Invader'),
    velocity: game.config.invaderInitialVelocity,
    left: (game.gameBounds.left + game.gameBounds.right * 3) / 4,
    right: game.gameBounds.right,
  }];
  this.rocketMaxFireRate = game.config.rocketMaxFireRate;
  this.rockets = [];
  this.lastAngleSample = game.lastAngleSample;
};

TutorialState.prototype.update = function(game, now, dt) {
  this.timeProgress += dt;

  if (this.lastAngleSample === game.lastAngleSample) {
    this.noDetectionTime += dt;
  } else {
    this.lastAngleSample = game.lastAngleSample;
    this.noDetectionTime = 0;
  }

  if (game.pose === LEFT_POSE) {
    this.ship.x -= this.shipSpeed * dt;
  } else if (game.pose === RIGHT_POSE) {
    this.ship.x += this.shipSpeed * dt;
  }
  if (this.ship.x < game.gameBounds.left) {
    this.ship.x = game.gameBounds.left;
  }
  if (this.ship.x > game.gameBounds.right) {
    this.ship.x = game.gameBounds.right;
  }

  //  Move each rocket.
  for(let i=0; i<this.rockets.length; i++) {
    const rocket = this.rockets[i];
    rocket.y -= dt * rocket.velocity;

    //  If the rocket has gone off the screen remove it.
    if (rocket.y < game.height / 2 + (0.22 * game.width)) {
      this.rockets.splice(i--, 1);
    }
  }

  const self = this;
  this.invaders.forEach((wrapper) => {
    const newx = wrapper.invader.x + wrapper.velocity * dt;
    if ((wrapper.left <= newx) && (newx <= wrapper.right)) {
      wrapper.invader.x = newx;
    } else {
      wrapper.velocity = -wrapper.velocity;
    }
    for(let j=0; j<self.rockets.length; j++){
      const rocket = self.rockets[j];
  
      if (rocket.x >= (wrapper.invader.x - wrapper.invader.width/2)
      && rocket.x <= (wrapper.invader.x + wrapper.invader.width/2)
      && rocket.y >= (wrapper.invader.y - wrapper.invader.height/2)
      && rocket.y <= (wrapper.invader.y + wrapper.invader.height/2)) {
        //  Remove the rocket, set 'bang' so we don't process
        //  this rocket again.
        self.rockets.splice(j--, 1);
        self.invaders = self.invaders.filter(x => x !== wrapper);
        // game.sounds.playSound('bang');
        break;
      }
    }
  });
};

function drawFaceDetectionWarning(ctx, game, warnProgress) {
  const warnOpacities = [0, 1, 1];
  ctx.fillStyle = 'rgba(255, 255, 0, ' + (
    warnOpacities[Math.floor(warnProgress * warnOpacities.length) % warnOpacities.length] * (1 - (warnProgress * warnOpacities.length - Math.floor(warnProgress * warnOpacities.length)))
    + warnOpacities[(Math.floor(warnProgress * warnOpacities.length) + 1) % warnOpacities.length] * (warnProgress * warnOpacities.length - Math.floor(warnProgress * warnOpacities.length))
  ) + ')';
  ctx.textBaseline="middle"; 
  ctx.textAlign="center";
  ctx.font='' + Math.floor(0.05 * game.width) + "px Arial";
  ctx.fillText(
    [
      "Cannot detect your face",
      "Try moving farther from camera",
      "Cannot detect your face",
      "Don't tilt your head too much"
    ][Math.floor(warnProgress) % 4],
    game.width / 2,
    0.06 * game.width,
    game.width
  );
}

TutorialState.prototype.draw = function(ctx, game, now, dt) {
  //  Clear the background.
  ctx.clearRect(0, 0, game.width, game.height);

  if (this.noDetectionTime > game.config.noDetectionTimeLimit) {
    drawFaceDetectionWarning(ctx, game, (this.noDetectionTime - game.config.noDetectionTimeLimit) * 0.4);
  }

  ctx.textBaseline="middle"; 
  ctx.textAlign="center";
  ctx.fillStyle = '#ffffff';
  ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
  ctx.fillText("Tilt your head moderately to", game.width / 2, 0.27 * game.width, game.width);
  ctx.fillText("move the spaceship to each side", game.width / 2, 0.33 * game.width, game.width);

  const angleMax = 25 * Math.PI / 180;

  let headAngle;
  const stage = Math.floor(this.timeProgress) % 4;
  const innerProcess = this.timeProgress - Math.floor(this.timeProgress);
  if (stage === 0) {
    headAngle = -angleMax;
  } else if (stage === 2) {
    headAngle = angleMax;
  } else {
    headAngle = ((stage === 1) ? 1 : -1) * ((-angleMax * (1 - innerProcess)) + (angleMax * innerProcess));
  }

  const imageSide = game.width * 0.4;
  const imageY = game.height / 2 + game.width * 0.06;
  ctx.translate(game.width / 2, imageY);
  ctx.rotate(headAngle);
  ctx.translate(-game.width / 2, -imageY);
  ctx.globalAlpha = 1;
  ctx.drawImage(game.images.alienFace, game.width / 2 - imageSide / 2, imageY - imageSide, imageSide, imageSide);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transformation

  ctx.font='' + Math.floor(0.06 * game.width) + "px Arial";
  ctx.fillText('Shout "PEW" to shoot a rocket', game.width / 2, game.height / 2 + (0.16 * game.width), game.width);
  ctx.font='' + Math.floor(0.04 * game.width) + "px Arial";
  ctx.fillText('(shoot the aliens below to continue)', game.width / 2, game.height / 2 + (0.21 * game.width), game.width);

  if (this.invaders.length > 0) {
    this.invaders.forEach((wrapper) => {
      // Draw invader
      ctx.globalAlpha = 1;
      ctx.drawImage(game.images.alien1, wrapper.invader.x - wrapper.invader.width/2, wrapper.invader.y - wrapper.invader.height/2, wrapper.invader.width, wrapper.invader.height);
    });
    // Draw rockets.
    ctx.fillStyle = '#77aaff';
    this.rockets.forEach((rocket) => {
      const rocketSize = Math.max(2, Math.floor(0.015 * game.width));
      ctx.fillRect(rocket.x, rocket.y - Math.floor(rocketSize / 2), rocketSize, rocketSize);
    });

    //  Draw ship.
    ctx.fillStyle = ((game.lastHit < now) || (Math.floor(now / 80) % 2 === 0)) ? '#999999' : '#990000';
    ctx.fillRect(this.ship.x - (this.ship.width / 2), this.ship.y - (this.ship.height / 2), this.ship.width, this.ship.height);
  } else {
    ctx.font='bold ' + Math.floor(0.09 * game.width) + "px Arial";
    ctx.fillText('CONTINUE', game.width / 2, game.height - Math.floor(0.18 * game.width));
  }
};

TutorialState.prototype.fireRocket = function() {
  //  If we have no last rocket time, or the last rocket time 
  //  is older than the max rocket rate, we can fire.
  const now = Date.now();
  if (this.lastRocketTime === null || (now - this.lastRocketTime) > (1000 / this.rocketMaxFireRate))
  {   
    //  Add a rocket.
    this.rockets.push(new Rocket(this.ship.x, this.ship.y - (this.ship.height / 2), this.config.rocketVelocity));
    this.lastRocketTime = now;
    
    //  Play the 'shoot' sound.
    // game.sounds.playSound('shoot');
  }
};

TutorialState.prototype.volumeUp = function() {
  this.fireRocket();
}
/*
TutorialState.prototype.keyUp = function(game, keyCode) {
  if (keyCode == KEY_SPACE) {
    // Fire!
    this.fireRocket();
  }
}
*/

TutorialState.prototype.click = function(game, x, y) {
  if ((this.invaders.length === 0) && (game.height - 0.225 * game.width < y) && (y < game.height - 0.15 * game.width)) {
    game.level = 1;
    game.score = 0;
    game.lives = initialLives;
    game.moveToState(new LevelIntroState(1));
  }
};

function GameOverState() {
  this.videoUrl = null;
  this.shareVisible = false;
  this.videoFormatMessageVisible = false;
}

GameOverState.prototype.enter = function(game) {
  const self = this;
  this.enterTime = Date.now();
  this.videoTop = Math.floor(game.width * 0.21);
  if (game.medianVoiceInterval) {
    clearInterval(game.medianVoiceInterval);
    game.medianVoiceInterval = null;
  }
  const mediaRecorder = game.mainCamvas.mediaRecorder;
  if (game.mainCamvas.stream) {
    game.mainCamvas.stream.getTracks().forEach(track => track.stop());
  }
  if (game.mainCamvas.mediaRecorderStream) {
    game.mainCamvas.mediaRecorderStream.getTracks().forEach(track => track.stop());
  }
  if (mediaRecorder) {
    game.mainCamvas.allowStreamReset = false;
    mediaRecorder.onstop = () => {
      mediaRecorder.onstop = undefined;
      // safety - wait for last media-chunk
      setTimeout(() => {
        game.mainCamvas.video.srcObject = null;
        if (game.mainCamvas.video.parentElement) { // safety
          game.mainCamvas.video.parentElement.removeChild(game.mainCamvas.video);
        }
        const newVideo = document.createElement('video');
        console.log('creating blob with type: ' + game.mediaRecorderOutputType);
        self.videoUrl = URL.createObjectURL(new Blob(game.mainCamvas.mediaChunks, { type: game.mediaRecorderOutputType }));
        newVideo.src = self.videoUrl;

        const maxWidth = game.width;
        const maxHeight = game.width * 0.8;
        console.log('video max width: ' + maxWidth);
        console.log('video max height: ' + maxHeight);
        console.log('video original width: ' + game.videoWidth);
        console.log('video original height: ' + game.videoHeight);
        const videoRatio = game.videoWidth / game.videoHeight;
        if (videoRatio > maxWidth / maxHeight) {
          // the width is too large
          newVideo.setAttribute('width', maxWidth);
          newVideo.setAttribute('height', Math.floor(maxWidth / videoRatio));
        } else {
          // height is too large
          newVideo.setAttribute('height', maxHeight);
          newVideo.setAttribute('width', Math.floor(maxHeight * videoRatio));
        }

        newVideo.setAttribute('autoplay', 1);
        newVideo.setAttribute('playsinline', 1);
        newVideo.className = 'displayed-video';
        newVideo.loop = true;
        newVideo.mutead = false;
        // newVideo.style.maxWidth = '' + game.width + 'px';
        // newVideo.style.maxHeight = '' + Math.floor(game.width * 0.8) + 'px';
        newVideo.style.top = '' + (self.videoTop + document.getElementById('gameCanvas').offsetTop) + 'px';
        newVideo.onclick = () => {
          self.hideShareVisible();
        }
        document.getElementById('gamecontainer').appendChild(newVideo);
      }, 500);
    }
    mediaRecorder.stop();
  } else if (game.imageSamples.length > 0) {
    // cannot play video
    game.mainCamvas.shouldStopLoop = true; // stops the loop so the canvas can be used
    this.imageSamples = game.imageSamples;
    this.zoomCanvas = document.createElement('canvas');
    this.zoomCanvas.width = 1;
    this.zoomCanvas.height = 1;
  }
};

GameOverState.prototype.leave = function(game) {
  this.hideShareVisible();
  document.getElementsByClassName('displayed-video').forEach((videoElement) => {
    if (videoElement.parentElement) {
      videoElement.parentElement.removeChild(videoElement);
    }
  });
}

GameOverState.prototype.update = function(game, now, dt) {
};

GameOverState.prototype.draw = function(ctx, game, now, dt) {
  //  Clear the background.
  ctx.clearRect(0, 0, game.width, game.height);

  if (this.imageSamples && (this.imageSamples.length > 0)) {
    const imageSample = this.imageSamples[Math.floor((now - this.enterTime) / game.config.imageSampleFrameRate) % this.imageSamples.length];
    if (imageSample.width !== this.zoomCanvas.width) {
      this.zoomCanvas.width = imageSample.width;
    } 
    if (imageSample.height !== this.zoomCanvas.height) {
      this.zoomCanvas.height = imageSample.height;
    }
    this.zoomCanvas.getContext('2d').putImageData(imageSample, 0, 0);
    
    const maxWidth = game.width;
    const maxHeight = game.width * 0.8;

    const tooWide = (imageSample.width / imageSample.height > maxWidth / maxHeight);
    
    const scale = (tooWide ? (maxWidth / imageSample.width) : (maxHeight / imageSample.height));
    ctx.scale(scale, scale);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.zoomCanvas, tooWide ? 0 : Math.floor(((game.width / scale) - imageSample.width) / 2), Math.floor(this.videoTop / scale));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  
  ctx.font=Math.floor(0.07 * game.width) + "px Arial";
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline="top";
  ctx.textAlign="center"; 
  ctx.fillText("Your Space Has Been Invaded!", game.width / 2, game.width * 0.04, game.width * 0.95); 
  ctx.font=Math.floor(0.045 * game.width) + "px Arial";
  ctx.fillText("You scored " + game.score + " points and got to level " + game.level, game.width / 2, game.width * 0.12, game.width * 0.95);

  ctx.font=Math.floor(0.045 * game.width) + "px Arial";
  ctx.fillStyle = '#ffff00';
  ctx.textAlign="left";
  ctx.fillText("When you let random websites access your", game.width * 0.05, game.width * 1.02, game.width * 0.9);
  ctx.fillText("camera you never know who's recording!", game.width * 0.05, game.width * 1.07, game.width * 0.9);
  ctx.fillText("This website doesn't upload the recording", game.width * 0.05, game.width * 1.12, game.width * 0.9);
  ctx.fillText("but other websites might!", game.width * 0.05, game.width * 1.17, game.width * 0.9);
  if (!this.shareVisible && !this.videoFormatMessageVisible) {
    ctx.fillStyle = '#ffffff';
    ctx.textAlign="center";
    ctx.font='bold ' + Math.floor(0.06 * game.width) + "px Arial";
    ctx.fillText("CREDITS/HELP", game.width * 0.25, game.width * 1.25, (game.width / 2) * 0.9);
    ctx.fillText("PLAY AGAIN", game.width * 0.75, game.width * 1.25, (game.width / 2) * 0.9);
    ctx.fillText("SHARE", game.width * 0.25, game.width * 1.33, (game.width / 2) * 0.9);
    if (this.videoUrl) {
      ctx.fillText("SAVE VIDEO", game.width * 0.75, game.width * 1.33, (game.width / 2) * 0.9);
    }
  } else if (this.videoFormatMessageVisible) {
    ctx.fillStyle = '#ffffff';
    ctx.textAlign="left";
    ctx.font=Math.floor(0.045 * game.width) + "px Arial";
    ctx.fillText("The video is saved in WEBM format which", game.width * 0.05, game.width * 1.25, game.width * 0.9);
    ctx.fillText("cannot be shared on Whatsapp.", game.width * 0.05, game.width * 1.3, game.width * 0.9);
    ctx.fillText("We recommend using zamzar.com to convert", game.width * 0.05, game.width * 1.35, game.width * 0.9);
    ctx.fillText("the file to MP4.", game.width * 0.05, game.width * 1.4, game.width * 0.9);
  }
};

GameOverState.prototype.hideShareVisible = function() {
  document.getElementById('sharebuttons').style.visibility = 'hidden';
  this.shareVisible = false;
}

GameOverState.prototype.click = function(game, x, y) {
  if (this.shareVisible) {
    if (y < game.width * 1.25) {
      this.hideShareVisible();
    }
  } else if (this.videoFormatMessageVisible) {
    if (y < game.width * 1.25) {
      this.videoFormatMessageVisible = false;
    }
  } else {
    if ((game.width * 1.25 < y) && (y < game.width * 1.33)) {
      if (x < game.width * 0.5) {
        window.location.href = 'credits.html';
      } else {
        console.log('play again');
        window.location.reload();
      }
    } else if ((game.width * 1.33 < y) && (y < game.width * 1.41)) {
      if (x < game.width * 0.5) {
        this.shareVisible = true;
        document.getElementById('sharebuttons').style.visibility = 'visible';
      } else {
        if (this.videoUrl) {
          console.log('save video');
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = this.videoUrl;
          // the filename you want
          a.download = 'spaceinvadersai.' + game.mediaRecorderFilenameExtension;
          document.body.appendChild(a);
          a.click();
          this.videoFormatMessageVisible = true;
        }
      }
    }
  }
}

/*
GameOverState.prototype.keyDown = function(game, keyCode) {
  if(keyCode == KEY_SPACE) {
    //  Space restarts the game.
    game.lives = initialLives;
    game.score = 0;
    game.level = 1;
    game.moveToState(new LevelIntroState(1));
  }
};
*/

//  Create a PlayState with the game config and the level you are on.
function PlayState(config, level) {
  this.config = config;
  this.level = level;

  this.noDetectionTime = 0;
  //  Game state.
  this.invaderCurrentVelocity =  10;
  this.invaderCurrentDropDistance =  0;
  this.invadersAreDropping =  false;
  this.lastRocketTime = null;

  //  Game entities.
  this.ship = null;
  this.invaders = [];
  this.rockets = [];
  this.bombs = [];
}

PlayState.prototype.enter = function(game) {
  this.lastAngleSample = game.lastAngleSample;
  //  Create the ship.
  this.ship = new Ship(game, game.width / 2, Math.floor(game.gameBounds.bottom - 0.0275 * game.width));
  
  //  Setup initial state.
  this.invaderCurrentDropDistance =  0;
  this.invadersAreDropping =  false;
  
  //  Set the ship speed for this level, as well as invader params.
  const levelMultiplier = (this.level - 1) * this.config.levelDifficultyMultiplier;
  this.shipSpeed = this.config.shipSpeed;
  this.invaderInitialVelocity = this.config.invaderInitialVelocity * (1 + 1.5 * levelMultiplier);
  this.bombRate = this.config.bombRate * (1 + levelMultiplier * 2);
  this.bombMinVelocity = this.config.bombMinVelocity * (1 + levelMultiplier);
  this.bombMaxVelocity = this.config.bombMaxVelocity * (1 + levelMultiplier);
  this.rocketMaxFireRate = this.config.rocketMaxFireRate; // + 0.4 * limitLevel;
  
  //  Create the invaders.
  const ranks = this.config.invaderRanks + this.level;
  const files = this.config.invaderFiles;
  const invaders = [];
  for (let rank = 0; rank < ranks; rank++) {
    for (let file = 0; file < files; file++) {
      const invader = new Invader(
        game,
        Math.floor((game.width / 2) + ((files/2 - file) * 0.675 * game.width / files)),
        Math.floor(game.gameBounds.top + (rank + 2) * 0.075 * game.width),
        rank,
        file,
        'Invader'
      );
      invaders.push(invader);
    }
  }
  this.invaders = invaders;
  this.invaderCurrentVelocity = this.invaderInitialVelocity;
  this.invaderVelocity = {x: -this.invaderInitialVelocity, y:0};
  this.invaderNextVelocity = null;
};

PlayState.prototype.update = function(game, now, dt) {
  if (this.lastAngleSample === game.lastAngleSample) {
    this.noDetectionTime += dt;
  } else {
    this.lastAngleSample = game.lastAngleSample;
    this.noDetectionTime = 0;
  }
  //  If the left or right arrow keys are pressed, move
  //  the ship. Check this on ticks rather than via a keydown
  //  event for smooth movement, otherwise the ship would move
  //  more like a text editor caret.
  if (game.pose === LEFT_POSE) {
    this.ship.x -= this.shipSpeed * dt;
  } else if (game.pose === RIGHT_POSE) {
    this.ship.x += this.shipSpeed * dt;
  }
  //  Keep the ship in bounds.
  if (this.ship.x < game.gameBounds.left) {
    this.ship.x = game.gameBounds.left;
  }
  if (this.ship.x > game.gameBounds.right) {
    this.ship.x = game.gameBounds.right;
  }
  
  /*
  if(game.pressedKeys[KEY_SPACE]) {
    this.fireRocket();
  }
  */
  //  Move each bomb.
  for(let i=0; i<this.bombs.length; i++) {
    var bomb = this.bombs[i];
    bomb.y += dt * bomb.velocity;
    
    //  If the rocket has gone off the screen remove it.
    if(bomb.y > this.height) {
      this.bombs.splice(i--, 1);
    }
  }
  
  //  Move each rocket.
  for(let i=0; i<this.rockets.length; i++) {
    const rocket = this.rockets[i];
    rocket.y -= dt * rocket.velocity;
    
    //  If the rocket has gone off the screen remove it.
    if(rocket.y < 0) {
      this.rockets.splice(i--, 1);
    }
  }
  
  //  Move the invaders.
  var hitLeft = false, hitRight = false, hitBottom = false;
  for(let i=0; i<this.invaders.length; i++) {
    var invader = this.invaders[i];
    var newx = invader.x + this.invaderVelocity.x * dt;
    var newy = invader.y + this.invaderVelocity.y * dt;
    if(hitLeft == false && newx < game.gameBounds.left) {
      hitLeft = true;
    }
    else if(hitRight == false && newx > game.gameBounds.right) {
      hitRight = true;
    }
    else if(hitBottom == false && newy > game.gameBounds.bottom) {
      hitBottom = true;
    }
    
    if(!hitLeft && !hitRight && !hitBottom) {
      invader.x = newx;
      invader.y = newy;
    }
  }
  
  //  Update invader velocities.
  if(this.invadersAreDropping) {
    this.invaderCurrentDropDistance += this.invaderVelocity.y * dt;
    if(this.invaderCurrentDropDistance >= this.config.invaderDropDistance) {
      this.invadersAreDropping = false;
      this.invaderVelocity = this.invaderNextVelocity;
      this.invaderCurrentDropDistance = 0;
    }
  }
  //  If we've hit the left, move down then right.
  if(hitLeft) {
    this.invaderCurrentVelocity += this.config.invaderAcceleration;
    this.invaderVelocity = {x: 0, y:this.invaderCurrentVelocity };
    this.invadersAreDropping = true;
    this.invaderNextVelocity = {x: this.invaderCurrentVelocity , y:0};
  }
  //  If we've hit the right, move down then left.
  if(hitRight) {
    this.invaderCurrentVelocity += this.config.invaderAcceleration;
    this.invaderVelocity = {x: 0, y:this.invaderCurrentVelocity };
    this.invadersAreDropping = true;
    this.invaderNextVelocity = {x: -this.invaderCurrentVelocity , y:0};
  }
  //  If we've hit the bottom, it's game over.
  if(hitBottom) {
    game.lives = 0;
  }
  
  //  Check for rocket/invader collisions.
  for(let i=0; i<this.invaders.length; i++) {
    var invader = this.invaders[i];
    var bang = false;
    
    for(var j=0; j<this.rockets.length; j++){
      var rocket = this.rockets[j];
      
      if(rocket.x >= (invader.x - invader.width/2) && rocket.x <= (invader.x + invader.width/2) &&
      rocket.y >= (invader.y - invader.height/2) && rocket.y <= (invader.y + invader.height/2)) {
        
        //  Remove the rocket, set 'bang' so we don't process
        //  this rocket again.
        this.rockets.splice(j--, 1);
        bang = true;
        game.score += this.config.pointsPerInvader;
        break;
      }
    }
    if(bang) {
      this.invaders.splice(i--, 1);
      // game.sounds.playSound('bang');
    }
  }
  
  //  Find all of the front rank invaders.
  var frontRankInvaders = {};
  for(let i=0; i<this.invaders.length; i++) {
    var invader = this.invaders[i];
    //  If we have no invader for game file, or the invader
    //  for game file is futher behind, set the front
    //  rank invader to game one.
    if(!frontRankInvaders[invader.file] || frontRankInvaders[invader.file].rank < invader.rank) {
      frontRankInvaders[invader.file] = invader;
    }
  }
  
  //  Give each front rank invader a chance to drop a bomb.
  for (let i=0; i<this.config.invaderFiles; i++) {
    var invader = frontRankInvaders[i];
    if (!invader) {
      continue;
    }
    var chance = this.bombRate * dt;
    if (chance > Math.random()) {
      // Fire!
      const newBomb = new Bomb(
        invader.x,
        invader.y + invader.height / 2, 
        this.bombMinVelocity + Math.random() * (this.bombMaxVelocity - this.bombMinVelocity),
        );
      this.bombs.push(newBomb);  
    }
  }
  
  //  Check for bomb/ship collisions.
  for(let i=0; i<this.bombs.length; i++) {
    var bomb = this.bombs[i];
    if(bomb.x >= (this.ship.x - this.ship.width/2) && bomb.x <= (this.ship.x + this.ship.width/2) &&
    bomb.y >= (this.ship.y - this.ship.height/2) && bomb.y <= (this.ship.y + this.ship.height/2)) {
      this.bombs.splice(i--, 1);
      game.lives--;
      game.lastHit = Date.now();
      // game.sounds.playSound('explosion');
    }
    
  }
  
  //  Check for invader/ship collisions.
  for(let i=0; i<this.invaders.length; i++) {
    var invader = this.invaders[i];
    if((invader.x + invader.width/2) > (this.ship.x - this.ship.width/2) && 
    (invader.x - invader.width/2) < (this.ship.x + this.ship.width/2) &&
    (invader.y + invader.height/2) > (this.ship.y - this.ship.height/2) &&
    (invader.y - invader.height/2) < (this.ship.y + this.ship.height/2)) {
      //  Dead by collision!
      game.lives = 0;
      // game.sounds.playSound('explosion');
    }
  }
  
  //  Check for failure
  if(game.lives <= 0) {
    game.moveToState(new GameOverState());
  }
  
  //  Check for victory
  if(this.invaders.length === 0) {
    game.score += this.level * 50;
    game.level += 1;
    game.moveToState(new LevelIntroState(game.level));
  }
};

PlayState.prototype.draw = function(ctx, game, now, dt) {
  //  Clear the background.
  ctx.clearRect(0, 0, game.width, game.height);
  
  if (this.noDetectionTime > game.config.noDetectionTimeLimit) {
    drawFaceDetectionWarning(ctx, game, (this.noDetectionTime - game.config.noDetectionTimeLimit) * 0.4);
  }
  
  //  Draw ship.
  ctx.fillStyle = ((game.lastHit < Date.now() - 1e3) || (Math.floor(Date.now() / 80) % 2 === 0)) ? '#999999' : '#990000';
  ctx.fillRect(this.ship.x - (this.ship.width / 2), this.ship.y - (this.ship.height / 2), this.ship.width, this.ship.height);
  
  //  Draw invaders.
  // ctx.fillStyle = '#006600';
  for(var i=0; i<this.invaders.length; i++) {
    var invader = this.invaders[i];
    ctx.globalAlpha = 1;
    ctx.drawImage([game.images.alien1, game.images.alien2, game.images.alien3, game.images.alien4][invader.rank % 4], invader.x - invader.width/2, invader.y - invader.height/2, invader.width, invader.height);
  }
  
  //  Draw bombs.
  ctx.fillStyle = '#ff5555';
  for(var i=0; i<this.bombs.length; i++) {
    var bomb = this.bombs[i];
    var bombSize = Math.max(2, Math.floor(0.015 * game.width));
    ctx.fillRect(bomb.x - bombSize, bomb.y - Math.floor(bombSize / 2), bombSize, bombSize);
  }
  
  //  Draw rockets.
  ctx.fillStyle = '#77aaff';
  this.rockets.forEach((rocket) => {
    const rocketSize = Math.max(2, Math.floor(0.015 * game.width));
    ctx.fillRect(rocket.x, rocket.y - Math.floor(rocketSize / 2), rocketSize, rocketSize);
  });
  
  //  Draw info.
  var textYpos = ((game.height + game.gameBounds.bottom) / 2);
  ctx.font=Math.floor(0.035 * game.width) + "px Arial";
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = "left";
  ctx.fillText("Lives: " + game.lives, game.gameBounds.left, textYpos);
  ctx.textAlign = "right";
  ctx.fillText("Score: " + game.score + ", Level: " + game.level, game.gameBounds.right, textYpos);
  
  //  If we're in debug mode, draw bounds.
  if(this.config.debugMode) {
    ctx.strokeStyle = '#ff0000';
    ctx.strokeRect(0,0,game.width, game.height);
    ctx.strokeRect(
      game.gameBounds.left,
      game.gameBounds.top,
      game.gameBounds.right - game.gameBounds.left,
      game.gameBounds.bottom - game.gameBounds.top
    );
  }    
};

PlayState.prototype.volumeUp = function() {
  this.fireRocket();
}

/*
PlayState.prototype.keyUp = function(game, keyCode) {
  if(keyCode == KEY_SPACE) {
    //  Fire!
    this.fireRocket();
  }
  if(keyCode == 80) {
    //  Push the pause state.
    game.pushState(new PauseState());
  }
  if(keyCode == 83) {
    this.invaderCurrentVelocity *= 1.1;
  }
};
*/

/*
PlayState.prototype.keyUp = function(game, keyCode) {

};
*/

PlayState.prototype.fireRocket = TutorialState.prototype.fireRocket;

function PauseState() {

}

PauseState.prototype.keyUp = function(game, keyCode) {

    if(keyCode == 80) {
        //  Pop the pause state.
        game.popState();
    }
};

PauseState.prototype.draw = function(ctx, game, now, dt) {

    //  Clear the background.
    ctx.clearRect(0, 0, game.width, game.height);

    ctx.font="" + Math.floor(0.035 * game.width) + "px Arial";
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline="middle";
    ctx.textAlign="center";
    ctx.fillText("Paused", game.width / 2, game.height/2);
    return;
};

/*  
    Level Intro State

    The Level Intro state shows a 'Level X' message and
    a countdown for the level.
*/
function LevelIntroState(level) {
    this.level = level;
    this.countdownMessage = "2";
}

LevelIntroState.prototype.update = function(game, now, dt) {

    //  Update the countdown.
    if(this.countdown === undefined) {
        this.countdown = 2; // countdown from 3 secs
    }
    this.countdown -= dt;

    if(this.countdown < 2) { 
        this.countdownMessage = "2"; 
    }
    if(this.countdown < 1) { 
        this.countdownMessage = "1"; 
    } 
    if(this.countdown <= 0) {
        //  Move to the next level, popping this state.
        game.moveToState(new PlayState(game.config, this.level));
    }

};

LevelIntroState.prototype.draw = function(ctx, game, now, dt) {

    //  Clear the background.
    ctx.clearRect(0, 0, game.width, game.height);

    ctx.font= Math.floor(0.09 * game.width) + "px Arial";
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline="middle"; 
    ctx.textAlign="center"; 
    ctx.fillText("Level " + this.level, game.width / 2, game.height/2);
    ctx.font=Math.floor(0.06 * game.width) + "px Arial";
    ctx.fillText("Ready in " + this.countdownMessage, game.width / 2, game.height/2 + Math.floor(0.08 * game.width));
    return;
};


/*
 
  Ship

  The ship has a position and that's about it.

*/
function Ship(game, x, y) {
  this.x = x;
  this.y = y;
  this.width = Math.floor(0.075 * game.width);
  this.height = Math.floor(0.03 * game.width);
}

/*
    Rocket

    Fired by the ship, they've got a position, velocity and state.

    */
function Rocket(x, y, velocity) {
  this.x = x;
  this.y = y;
  this.velocity = velocity;
}

/*
    Bomb

    Dropped by invaders, they've got position, velocity.

*/
function Bomb(x, y, velocity) {
  this.x = x;
  this.y = y;
  this.velocity = velocity;
}
 
/*
    Invader 

    Invader's have position, type, rank/file and that's about it. 
*/

function Invader(game, x, y, rank, file, type) {
  this.x = x;
  this.y = y;
  this.rank = rank;
  this.file = file;
  this.type = type;
  this.width = Math.floor(0.075 * game.width);
  this.height = Math.floor(0.0635 * game.width);
}

/*
    Game State

    A Game State is simply an update and draw proc.
    When a game is in the state, the update and draw procs are
    called, with a dt value (dt is delta time, i.e. the number)
    of seconds to update or draw).

*/
function GameState(updateProc, drawProc, keyDown, keyUp, enter, leave) {
  this.updateProc = updateProc;
  this.drawProc = drawProc;
  this.keyDown = keyDown;
  this.keyUp = keyUp;
  this.enter = enter;
  this.leave = leave;
}

/*

    Sounds

    The sounds class is used to asynchronously load sounds and allow
    them to be played.

*/

/*
function Sounds() {
  
  //  The audio context.
  this.audioContext = null;
  
  //  The actual set of loaded sounds.
  this.sounds = {};
}

Sounds.prototype.init = function() {
  
  //  Create the audio context, paying attention to webkit browsers.
  context = window.AudioContext || window.webkitAudioContext;
  this.audioContext = new context();
  this.mute = false;
};

Sounds.prototype.loadSound = function(name, url) {
  //  Reference to ourselves for closures.
  var self = this;
  
  //  Create an entry in the sounds object.
  this.sounds[name] = null;
  
  //  Create an asynchronous request for the sound.
  var req = new XMLHttpRequest();
  req.open('GET', url, true);
  req.responseType = 'arraybuffer';
  req.onload = function() {
    self.audioContext.decodeAudioData(req.response, function(buffer) {
      self.sounds[name] = {buffer: buffer};
    });
  };
  try {
    req.send();
  } catch(e) {
    console.log("An exception occured getting sound the sound " + name + " this might be " +
    "because the page is running from the file system, not a webserver.");
    console.log(e);
  }
};

Sounds.prototype.playSound = function(name) {
  
  //  If we've not got the sound, don't bother playing it.
  if(this.sounds[name] === undefined || this.sounds[name] === null || this.mute === true) {
    return;
  }
  
  //  Create a sound source, set the buffer, connect to the speakers and
  //  play the sound.
  var source = this.audioContext.createBufferSource();
  source.buffer = this.sounds[name].buffer;
  source.connect(this.audioContext.destination);
  source.start(0);
};
*/