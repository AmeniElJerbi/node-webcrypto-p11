// Core
import * as webcrypto from "webcrypto-core";
const WebCryptoError = webcrypto.WebCryptoError;
const Base64Url = webcrypto.Base64Url;

import { IAlgorithm, ITemplate, KeyGenMechanism, KeyType, ObjectClass, SecretKey, Session } from "graphene-pk11";
import * as graphene from "graphene-pk11";

import { BaseCrypto } from "../base";
import { CryptoKey } from "../key";
import * as utils from "../utils";

export function create_template(session: Session, alg: AesKeyGenParams, extractable: boolean, keyUsages: string[]): ITemplate {

    const id = utils.GUID(session);
    return {
        token: !!process.env.WEBCRYPTO_PKCS11_TOKEN,
        sensitive: !!process.env.WEBCRYPTO_PKCS11_SENSITIVE,
        class: ObjectClass.SECRET_KEY,
        keyType: KeyType.AES,
        label: `AES-${alg.length}`,
        id,
        extractable,
        derive: false,
        sign: keyUsages.indexOf("sign") !== -1,
        verify: keyUsages.indexOf("verify") !== -1,
        encrypt: keyUsages.indexOf("encrypt") !== -1,
        decrypt: keyUsages.indexOf("decrypt") !== -1,
        wrap: keyUsages.indexOf("wrapKey") !== -1,
        unwrap: keyUsages.indexOf("unwrapKey") !== -1,
    };
}

export abstract class AesCrypto extends BaseCrypto {

    public static generateKey(algorithm: AesKeyGenParams, extractable: boolean, keyUsages: string[], session?: Session): PromiseLike<CryptoKey> {
        return (super.generateKey.apply(this, arguments))
            .then(() => {
                return new Promise((resolve, reject) => {
                    const template = create_template(session!, algorithm, extractable, keyUsages);
                    template.valueLen = algorithm.length >> 3;

                    // PKCS11 generation
                    session!.generateKey(KeyGenMechanism.AES, template, (err, aesKey) => {
                        try {
                            if (err) {
                                reject(new WebCryptoError(`Aes: Can not generate new key\n${err.message}`));
                            } else {
                                const key = new CryptoKey(aesKey, algorithm);
                                resolve(key);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
            });
    }

    public static exportKey(format: string, key: CryptoKey, session?: Session): PromiseLike<JsonWebKey | ArrayBuffer> {
        return super.exportKey.apply(this, arguments)
            .then(() => {
                return new Promise((resolve, reject) => {
                    const template = key.key.getAttribute({ value: null, valueLen: null });
                    switch (format.toLowerCase()) {
                        case "jwk":
                            const aes: string = /AES-(\w+)/.exec(key.algorithm.name!)![1];
                            const jwk: JsonWebKey = {
                                kty: "oct",
                                k: Base64Url.encode(template.value!),
                                alg: `A${template.valueLen! * 8}${aes}`,
                                ext: true,
                            };
                            resolve(jwk);
                            break;
                        case "raw":
                            resolve(template.value!.buffer);
                            break;
                        default:
                            throw new WebCryptoError(`Unknown format '${format}'`);
                    }
                });
            });
    }

    public static importKey(format: string, keyData: JsonWebKey | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray | Float32Array | Float64Array | DataView | ArrayBuffer, algorithm: string | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | DhImportKeyParams, extractable: boolean, keyUsages: string[], session?: Session): PromiseLike<CryptoKey> {
        return super.importKey.apply(this, arguments)
            .then(() => {
                return new Promise((resolve, reject) => {
                    // get key value
                    let value: Buffer;
                    if (format === "jwk") {
                        value = utils.b64_decode((keyData as JsonWebKey).k!);
                    } else {
                        value = keyData as Buffer;
                    }
                    // prepare key algorithm
                    const aesAlg: AesKeyGenParams = {
                        name: (algorithm as Algorithm).name,
                        length: value.length * 8,
                    };
                    const template: ITemplate = create_template(session!, aesAlg, extractable, keyUsages);
                    template.value = value;

                    // create session object
                    const sessionObject = session!.create(template);
                    resolve(new CryptoKey(sessionObject.toType<SecretKey>(), aesAlg));
                });
            });
    }

    public static encrypt(algorithm: Algorithm, key: CryptoKey, data: Buffer, session?: Session): PromiseLike<ArrayBuffer> {
        return super.encrypt.apply(this, arguments)
            .then(() => {
                // add padding if needed
                if (this.padding) {
                    const blockLength = 16;
                    const mod = blockLength - (data.length % blockLength);
                    const pad = new Buffer(mod);
                    pad.fill(mod);
                    data = Buffer.concat([data, pad]);
                }
            })
            .then(() => {
                return new Promise((resolve, reject) => {
                    session!.createCipher(this.wc2pk11(algorithm), key.key).once(data, new Buffer(this.getOutputBufferSize(key.algorithm as AesKeyAlgorithm, true, data.length)), (err, data2) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(data2.buffer);
                        }
                    });
                });
            });
    }

    public static decrypt(algorithm: Algorithm, key: CryptoKey, data: Buffer, session?: Session): PromiseLike<ArrayBuffer> {
        return super.decrypt.apply(this, arguments)
            .then(() => {
                return new Promise((resolve, reject) => {
                    session!.createDecipher(this.wc2pk11(algorithm), key.key).once(data, new Buffer(this.getOutputBufferSize(key.algorithm as AesKeyAlgorithm, false, data.length)), (err, data2) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(data2.buffer);
                        }
                    });
                });
            })
            .then((dec: ArrayBuffer) => {
                if (this.padding) {
                    // Remove padding
                    const buf = new Buffer(dec);
                    const paddingLength = buf[buf.length - 1];

                    const res = new Uint8Array(buf.slice(0, buf.length - paddingLength));
                    return res.buffer;
                } else {
                    return dec;
                }
            });
    }

    protected static padding = false;

    protected static wc2pk11(alg: Algorithm, session?: Session): IAlgorithm {
        throw new WebCryptoError(WebCryptoError.NOT_SUPPORTED);
    }

    /**
     * Returns a size of output buffer of enc/dec operation
     *
     * @protected
     * @static
     * @param {KeyAlgorithm} keyAlg key algorithm
     * @param {boolean} enc type of operation
     * `true` - encryption operation
     * `false` - decryption operation
     * @param {number} dataSize size of incoming data
     * @returns {number}
     *
     * @memberOf AesCrypto
     */
    protected static getOutputBufferSize(keyAlg: AesKeyAlgorithm, enc: boolean, dataSize: number): number {
        const len = keyAlg.length >> 3;
        if (enc) {
            return (Math.ceil(dataSize / len) * len) + len;
        } else {
            return dataSize;
        }
    }

}

export class AesGCM extends AesCrypto {

    protected static wc2pk11(alg: AesGcmParams, session?: Session): IAlgorithm {
        const aad = alg.additionalData ? utils.PrepareData(alg.additionalData) : undefined;
        let AesGcmParamsClass = graphene.AesGcmParams;
        if (session &&
            session.slot.module.cryptokiVersion.major >= 2 &&
            session.slot.module.cryptokiVersion.minor >= 40) {
            AesGcmParamsClass = graphene.AesGcm240Params;
        }
        const params = new AesGcmParamsClass(utils.PrepareData(alg.iv), aad, alg.tagLength || 128);
        return { name: "AES_GCM", params };
    }

}

export class AesCBC extends AesCrypto {
    protected static wc2pk11(alg: AesCbcParams, session?: Session): IAlgorithm {
        return { name: "AES_CBC_PAD", params: utils.PrepareData(alg.iv) };
    }
}

export class AesECB extends AesCrypto {

    protected static padding = true;

    protected static wc2pk11(alg: Algorithm, session?: Session): IAlgorithm {
        return { name: "AES_ECB", params: null };
    }

}
