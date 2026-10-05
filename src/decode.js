globalThis.VA = globalThis.VA || {};
VA.decode = (function () {
  var SIZE_GATE_BYTES = 1.5 * 1024 * 1024 * 1024;
  var DURATION_GATE_SEC = 3600;

  var MESSAGES = {
    'video-decode': '无法读取该视频的音频。两种可能：浏览器不支持它的编码格式（换成 Chrome/Edge 或转成 MP4/M4A），或它本来就没有音频轨（无声屏录）。',
    'audio-decode': '浏览器无法解码该文件的音频轨。请改用 Chrome/Edge，或先把文件转成 MP4/M4A。',
    'no-audio-data': '该文件不含可读取的音频数据。',
    'not-media': '这个文件看起来不是音视频文件，无法提取音频。'
  };

  function isMedia(file) {
    var t = (file && file.type) || '';
    return t.indexOf('audio/') === 0 || t.indexOf('video/') === 0;
  }

  // err 为解码 reject 的原因；buffer 为解码成功但可能空帧的结果。
  // 帧数的规范属性是 length，不是 numberOfFrames（Gecko 非标准旧别名，Chrome/Edge 为 undefined；
  // 写错时 `undefined === 0` 恒假，这条兜底分支会在真浏览器里静默失效）。
  function classifyError(file, err, buffer) {
    if (buffer && buffer.length === 0) {
      return mkError('no-audio-data', MESSAGES['no-audio-data']);
    }
    var t = (file && file.type) || '';
    if (!isMedia(file)) {
      return mkError('not-media', MESSAGES['not-media'] + '（检测到的类型：' + (t || '未知') + '）');
    }
    if (t.indexOf('video/') === 0) {
      return mkError('video-decode', MESSAGES['video-decode']);
    }
    return mkError('audio-decode', MESSAGES['audio-decode']);
  }

  function mkError(kind, message) {
    var e = new Error(message);
    e.kind = kind;
    return e;
  }

  function needSizeConfirm(file) { return file.size > SIZE_GATE_BYTES; }
  function needDurationConfirm(buffer) { return buffer.duration > DURATION_GATE_SEC; }

  function estimateMemoryBytes(buffer) {
    return buffer.length * buffer.numberOfChannels * 4;
  }

  function formatBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function sharedContext() {
    if (!VA.decode._ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      VA.decode._ctx = new Ctor();
    }
    return VA.decode._ctx;
  }

  function run(file) {
    return file.arrayBuffer().then(function (bytes) {
      var ctx = sharedContext();
      return new Promise(function (resolve, reject) {
        // 第二参 success callback 形式对旧 Safari 更稳；失败统一走 classifyError
        ctx.decodeAudioData(bytes, function (buffer) {
          if (!buffer || buffer.length === 0) {
            reject(classifyError(file, null, buffer || { length: 0 }));
            return;
          }
          resolve(buffer);
        }, function (err) {
          reject(classifyError(file, err));
        });
      });
    });
  }

  return {
    run: run,
    classifyError: classifyError,
    needSizeConfirm: needSizeConfirm,
    needDurationConfirm: needDurationConfirm,
    estimateMemoryBytes: estimateMemoryBytes,
    formatBytes: formatBytes,
    MESSAGES: MESSAGES,
    context: sharedContext
  };
})();

if (typeof module === 'object' && module.exports) module.exports = VA.decode;
