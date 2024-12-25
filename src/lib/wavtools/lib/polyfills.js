// Polyfill for globalThis
if (typeof globalThis === 'undefined') {
  Object.defineProperty(Object.prototype, '__magic__', {
    get: function() {
      return this;
    },
    configurable: true
  });
  globalThis = __magic__;
  delete Object.prototype.__magic__;
}

export default globalThis; 