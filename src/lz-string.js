const keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

function getBaseValue(alphabet, character) {
  const index = alphabet.indexOf(character);
  return index < 0 ? 0 : index;
}

export function compressToBase64(input) {
  if (input == null) return "";
  const result = compress(input, 6, (a) => keyStrBase64.charAt(a));

  switch (result.length % 4) {
    default:
    case 0:
      return result;
    case 1:
      return `${result}===`;
    case 2:
      return `${result}==`;
    case 3:
      return `${result}=`;
  }
}

export function decompressFromBase64(input) {
  if (input == null) return "";
  if (input === "") return null;

  return decompress(input.length, 32, (index) => getBaseValue(keyStrBase64, input.charAt(index)));
}

function compress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return "";

  let contextDictionary = {};
  let contextDictionaryToCreate = {};
  let contextC = "";
  let contextWC = "";
  let contextW = "";
  let contextEnlargeIn = 2;
  let contextDictSize = 3;
  let contextNumBits = 2;
  const contextData = [];
  let contextDataVal = 0;
  let contextDataPosition = 0;

  const writeBit = (value) => {
    contextDataVal = (contextDataVal << 1) | value;
    if (contextDataPosition === bitsPerChar - 1) {
      contextDataPosition = 0;
      contextData.push(getCharFromInt(contextDataVal));
      contextDataVal = 0;
    } else {
      contextDataPosition += 1;
    }
  };

  const writeBits = (numBits, value) => {
    for (let i = 0; i < numBits; i += 1) {
      writeBit(value & 1);
      value >>= 1;
    }
  };

  for (let ii = 0; ii < uncompressed.length; ii += 1) {
    contextC = uncompressed.charAt(ii);

    if (!Object.prototype.hasOwnProperty.call(contextDictionary, contextC)) {
      contextDictionary[contextC] = contextDictSize;
      contextDictSize += 1;
      contextDictionaryToCreate[contextC] = true;
    }

    contextWC = contextW + contextC;
    if (Object.prototype.hasOwnProperty.call(contextDictionary, contextWC)) {
      contextW = contextWC;
    } else {
      if (Object.prototype.hasOwnProperty.call(contextDictionaryToCreate, contextW)) {
        const charCode = contextW.charCodeAt(0);
        if (charCode < 256) {
          writeBits(contextNumBits, 0);
          writeBits(8, charCode);
        } else {
          writeBits(contextNumBits, 1);
          writeBits(16, charCode);
        }
        contextEnlargeIn -= 1;
        if (contextEnlargeIn === 0) {
          contextEnlargeIn = Math.pow(2, contextNumBits);
          contextNumBits += 1;
        }
        delete contextDictionaryToCreate[contextW];
      } else {
        writeBits(contextNumBits, contextDictionary[contextW]);
      }

      contextEnlargeIn -= 1;
      if (contextEnlargeIn === 0) {
        contextEnlargeIn = Math.pow(2, contextNumBits);
        contextNumBits += 1;
      }

      contextDictionary[contextWC] = contextDictSize;
      contextDictSize += 1;
      contextW = String(contextC);
    }
  }

  if (contextW !== "") {
    if (Object.prototype.hasOwnProperty.call(contextDictionaryToCreate, contextW)) {
      const charCode = contextW.charCodeAt(0);
      if (charCode < 256) {
        writeBits(contextNumBits, 0);
        writeBits(8, charCode);
      } else {
        writeBits(contextNumBits, 1);
        writeBits(16, charCode);
      }
      contextEnlargeIn -= 1;
      if (contextEnlargeIn === 0) {
        contextEnlargeIn = Math.pow(2, contextNumBits);
        contextNumBits += 1;
      }
      delete contextDictionaryToCreate[contextW];
    } else {
      writeBits(contextNumBits, contextDictionary[contextW]);
    }

    contextEnlargeIn -= 1;
    if (contextEnlargeIn === 0) {
      contextEnlargeIn = Math.pow(2, contextNumBits);
      contextNumBits += 1;
    }
  }

  writeBits(contextNumBits, 2);

  while (true) {
    contextDataVal <<= 1;
    if (contextDataPosition === bitsPerChar - 1) {
      contextData.push(getCharFromInt(contextDataVal));
      break;
    }
    contextDataPosition += 1;
  }

  return contextData.join("");
}

function decompress(length, resetValue, getNextValue) {
  const dictionary = [0, 1, 2];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = "";
  const result = [];
  let w;
  let bits;
  let resb;
  let maxpower;
  let power;
  let c;

  const data = {
    val: getNextValue(0),
    position: resetValue,
    index: 1,
  };

  const readBits = (bitCount) => {
    bits = 0;
    maxpower = Math.pow(2, bitCount);
    power = 1;
    while (power !== maxpower) {
      resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index);
        data.index += 1;
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  switch (readBits(2)) {
    case 0:
      c = String.fromCharCode(readBits(8));
      break;
    case 1:
      c = String.fromCharCode(readBits(16));
      break;
    case 2:
      return "";
    default:
      return null;
  }

  dictionary[3] = c;
  w = c;
  result.push(c);

  while (true) {
    if (data.index > length) return "";

    c = readBits(numBits);

    switch (c) {
      case 0:
        dictionary[dictSize] = String.fromCharCode(readBits(8));
        c = dictSize;
        dictSize += 1;
        enlargeIn -= 1;
        break;
      case 1:
        dictionary[dictSize] = String.fromCharCode(readBits(16));
        c = dictSize;
        dictSize += 1;
        enlargeIn -= 1;
        break;
      case 2:
        return result.join("");
      default:
        break;
    }

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }

    if (dictionary[c]) {
      entry = dictionary[c];
    } else if (c === dictSize) {
      entry = w + w.charAt(0);
    } else {
      return null;
    }

    result.push(entry);
    dictionary[dictSize] = w + entry.charAt(0);
    dictSize += 1;
    enlargeIn -= 1;
    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits += 1;
    }
  }
}
