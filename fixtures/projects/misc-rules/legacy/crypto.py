from Crypto.Cipher import AES, DES


def legacy(key, data):
    return DES.new(key, DES.MODE_CBC).encrypt(data)  # expect: sec/weak-cipher


def ecb(key, data):
    return AES.new(key, AES.MODE_ECB).encrypt(data)  # expect: sec/weak-cipher
