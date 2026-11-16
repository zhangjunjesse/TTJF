/* Preview bridge: the production renderer is the only drawing source. */
(function (root) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = require('../../pet.js'); }
  else { root.FamilyPetV6 = root.FamilyPet; }
}(typeof self !== 'undefined' ? self : this));
