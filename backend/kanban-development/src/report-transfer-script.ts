// Streaming report packaging runs through the injected project process capability.
export const reportTransferScript = String.raw`import gzip,hashlib,io,json,os,stat,sys,tarfile
from pathlib import Path
config=json.loads(sys.argv[1])
source=Path(config['source']);target=Path(config['target'])
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
def reports():
 rows=[];total=0;root=source/'_nestos/kanban'
 for part in (source/'_nestos',root,root/'artifacts'):
  if part.is_symlink():raise RuntimeError('SOFTWARE_REPORT_TYPE_UNSUPPORTED')
 candidates=[]
 artifacts=root/'artifacts'
 if artifacts.exists():
  for directory,dirs,files in os.walk(artifacts,followlinks=False):
   dirs[:]=sorted(d for d in dirs if d not in ('node_modules','dist','build','dist-server','dist-ui','.cache','cache','profile','profiles','state') and not (Path(directory)/d).is_symlink())
   candidates.extend(Path(directory)/f for f in sorted(files))
 if root.exists():candidates.extend(p for p in root.iterdir() if p.is_file() and any(word in p.name.lower() for word in ('report','handoff')))
 for path in sorted(set(candidates)):
  info=path.lstat()
  if not stat.S_ISREG(info.st_mode):raise RuntimeError('SOFTWARE_REPORT_TYPE_UNSUPPORTED')
  total+=info.st_size
  if len(rows)>=config['maxFiles'] or total>config['maxBytes']:raise RuntimeError('SOFTWARE_REPORT_BUDGET_EXCEEDED')
  rows.append({'path':str(path.relative_to(source)),'bytes':info.st_size,'sha256':digest(path)})
 return rows
def ensure_directory(path):
 if path.parent!=path:ensure_directory(path.parent)
 if path.exists():
  if path.is_symlink() or not path.is_dir():raise RuntimeError('SOFTWARE_REPORT_TARGET_INVALID')
 else:path.mkdir(mode=0o700)
def verify(path,meta):
 if path.is_symlink() or not path.is_file() or digest(path)!=meta['sha256']:raise RuntimeError('SOFTWARE_REPORT_DIGEST_MISMATCH')
 with tarfile.open(path,'r:gz') as archive:
  names=archive.getnames()
  if names!=['delivery.json']+[row['path'] for row in meta['files']]:raise RuntimeError('SOFTWARE_REPORT_PACKAGE_INVALID')
  for row in meta['files']:
   h=hashlib.sha256()
   with archive.extractfile(row['path']) as stream:
    for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
   if h.hexdigest()!=row['sha256']:raise RuntimeError('SOFTWARE_REPORT_DIGEST_MISMATCH')
 return meta
def main():
 rows=reports();fingerprint=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 path=target/(fingerprint+'.tar.gz');receipt=target/(fingerprint+'.json')
 if receipt.exists():
  meta=json.loads(receipt.read_text())
  if meta.get('fingerprint')!=fingerprint or meta.get('files')!=rows or meta.get('resourceId')!=config['resourceId'] or meta.get('owner')!=config['owner']:raise RuntimeError('SOFTWARE_REPORT_PACKAGE_INVALID')
  verify(path,meta);return meta
 if config['mode']=='inspect':return {'fingerprint':fingerprint,'fileCount':len(rows),'bytes':sum(r['bytes'] for r in rows),'existing':False}
 if config['mode']=='verify':raise RuntimeError('SOFTWARE_REPORT_HANDOFF_UNCONFIRMED')
 if fingerprint!=config['fingerprint']:raise RuntimeError('SOFTWARE_REPORT_SOURCE_CHANGED')
 ensure_directory(target)
 if path.exists():raise RuntimeError('SOFTWARE_REPORT_HANDOFF_UNCONFIRMED')
 manifest={'schema':'nestos.software-reports/1','resourceId':config['resourceId'],'owner':config['owner'],'fingerprint':fingerprint,'files':rows}
 temporary=target/('.packing-'+fingerprint)
 with temporary.open('xb') as raw:
  with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0) as compressed:
   with tarfile.open(fileobj=compressed,mode='w|') as archive:
    content=json.dumps(manifest,sort_keys=True).encode();info=tarfile.TarInfo('delivery.json');info.size=len(content);info.mode=0o600;archive.addfile(info,io.BytesIO(content))
    for row in rows:
     item=source/row['path'];info=archive.gettarinfo(str(item),arcname=row['path']);info.uid=info.gid=info.mtime=0;info.uname=info.gname=''
     with item.open('rb') as stream:archive.addfile(info,stream)
  raw.flush();os.fsync(raw.fileno())
 if reports()!=rows:raise RuntimeError('SOFTWARE_REPORT_SOURCE_CHANGED')
 meta={**manifest,'path':str(path),'bytes':temporary.stat().st_size,'sha256':digest(temporary)}
 verify(temporary,meta);os.rename(temporary,path)
 receipt_tmp=target/('.receipt-'+fingerprint)
 with receipt_tmp.open('x') as stream:stream.write(json.dumps(meta,sort_keys=True));stream.flush();os.fsync(stream.fileno())
 os.rename(receipt_tmp,receipt)
 descriptor=os.open(target,os.O_RDONLY)
 try:os.fsync(descriptor)
 finally:os.close(descriptor)
 return meta
try:
 value=main();print(json.dumps(value if config['mode']!='inspect' or not value.get('sha256') else {**value,'existing':True}))
except Exception as error:
 code=str(error) if str(error).startswith('SOFTWARE_REPORT_') else 'SOFTWARE_REPORT_TRANSFER_FAILED'
 print(json.dumps({'code':code,'class':type(error).__name__}));sys.exit(1)
`;
