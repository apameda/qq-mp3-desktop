from pathlib import Path
import base64,hashlib,json,struct,sys
sys.path.insert(0,str(Path(__file__).parent/'reference-python'))
import libtakiyasha._stdciphers as reference_std
from libtakiyasha.qmc._qmcdataciphers import Mask128,HardenedRC4
from libtakiyasha.qmc._qmckeyciphers import QMCv2KeyEncryptV1,make_core_key

out=Path(__file__).parent/'reference-vectors'
out.mkdir(exist_ok=True)
# Only the random padding source is made deterministic; reference algorithms are unmodified.
rng_state=0x514D4332
def fixture_random_byte():
 global rng_state
 rng_state=(1664525*rng_state+1013904223)&0xffffffff
 return rng_state>>24
reference_std.rand=fixture_random_byte

def digest(data):return hashlib.sha256(data).hexdigest()
def write(name,data):
 (out/name).write_bytes(data)
 return {'file':name,'bytes':len(data),'sha256':digest(data)}
size=600123
clear=b'fLaC'+bytes(((i*73+19)^(i//251))&255 for i in range(size-4))
clear_info=write('deterministic-pattern.bin',clear)
mask=(out.parent/'v1-reference-mask.bin').read_bytes()
assert len(mask)==len(clear)
# Independent C++ seed-walk and Python periodic Mask128 implementations must agree.
python_v1=Mask128(mask[:128]).encrypt(bytes(size))
assert python_v1==mask,'C++ and Python v1 mismatch'
records=[]
record=write('v1-presburger.qmcflac',bytes(a^b for a,b in zip(clear,mask)))
record.update({'scheme':'QMCv1','reference':'Presburger seed::next_mask (C++)','expectedPlaintext':clear_info['file'],'masterKeyHex':None})
records.append(record)

for sizekey,kind in ((256,'map'),(512,'rc4')):
 key=bytes(33+((i*37+11)%90) for i in range(sizekey))
 wrap=QMCv2KeyEncryptV1(make_core_key(106,8))
 wrapped=wrap.encrypt(key)
 assert wrap.decrypt(wrapped)==key
 ekey=base64.b64encode(wrapped)
 cipher=Mask128.from_qmcv2_key256(key) if sizekey==256 else HardenedRC4(key)
 encrypted=cipher.encrypt(clear)
 assert cipher.decrypt(encrypted)==clear
 rawrec=write(f'v2-{kind}-data.bin',encrypted)
 rawrec.update({'scheme':'QMCv2','reference':'LibTakiyasha 2.1.1.post1 original release','masterKeyHex':key.hex(),'ekey':ekey.decode(),'expectedPlaintext':clear_info['file']})
 records.append(rawrec)
 for footer in ('length','QTag','STag'):
  if footer=='length': tail=ekey+struct.pack('<I',len(ekey))
  else:
   csv=(ekey+b',123456,2') if footer=='QTag' else b'123456,2,fixturetest000'
   tail=csv+struct.pack('>I',len(csv))+footer.encode()
  rec=write(f'v2-{kind}-{footer}.mflac',encrypted+tail)
  rec.update({'scheme':'QMCv2','footer':footer,'dataBytes':len(encrypted),'expectedPlaintext':clear_info['file'],'masterKeyHex':key.hex(),'ekey':ekey.decode(),'reference':'LibTakiyasha 2.1.1.post1 original release'})
  records.append(rec)

boundaryOffsets=(0,1,126,127,128,129,5119,5120,5121,32766,32767,32768,32769,65534,65535,65536,98302)
manifest={'fixtureType':'synthetic non-audio deterministic bytes; not a real song or valid playable audio','plaintext':clear_info,'records':records,'v1IndependentAgreement':{'references':['Presburger qmc-decoder src/seed.hpp compiled C++','LibTakiyasha 2.1.1.post1 Mask128 Python'],'bytesCompared':len(mask),'maskSha256':digest(mask),'boundaryMaskBytes':{str(i):mask[i:i+8].hex() for i in boundaryOffsets}},'provenance':{'libtakiyashaWheel':'https://files.pythonhosted.org/packages/a8/fa/31ffe7dc86994b54f88c063917c04ed6bc5ece316d37a088f703e60cb31d/libtakiyasha-2.1.1.post1-py3-none-any.whl','wheelSha256':'b92f9a2db245c1cd70e74118780c35dd8cf09ab4aac35d83221ad49060aa705a','presburgerSource':'https://github.com/presburger/qmc-decoder/blob/master/src/seed.hpp','presburgerSourceSha256':digest((out.parent/'reference-src/presburger/seed.hpp').read_bytes())}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'directory':str(out),'vectors':len(records),'plaintextBytes':len(clear),'v1AgreementBytes':len(mask),'boundaries':manifest['v1IndependentAgreement']['boundaryMaskBytes']},indent=2))
