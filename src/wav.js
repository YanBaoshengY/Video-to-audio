globalThis.VA = globalThis.VA || {};
VA.wav = (function () {
  var BITS = 16;

  function to16(x) {
    var v = x;
    if (!(v === v)) v = 0;               // NaN
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    return v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7FFF);
  }

  function writeStr(view, off, s) {
    for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  }

  // channels: Float32Array[]，各声道等长。返回 16-bit PCM WAV Blob。
  function encode(channels, sampleRate) {
    if (!Array.isArray(channels) && !isList(channels)) throw new TypeError('channels 必须是 Float32Array 数组');
    if (!channels.length) throw new TypeError('channels 不能为空');
    var numChannels = channels.length;
    var frames = channels[0].length;
    var blockAlign = numChannels * (BITS / 8);
    var byteRate = sampleRate * blockAlign;
    var dataSize = frames * blockAlign;
    var out = new ArrayBuffer(44 + dataSize);
    var view = new DataView(out);

    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, BITS, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    var off = 44;
    for (var f = 0; f < frames; f++) {
      for (var c = 0; c < numChannels; c++) {
        view.setInt16(off, to16(channels[c][f]), true);
        off += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  function isList(x) { return typeof x === 'object' && typeof x.length === 'number'; }

  return { encode: encode, to16: to16 };
})();

if (typeof module === 'object' && module.exports) module.exports = VA.wav;
