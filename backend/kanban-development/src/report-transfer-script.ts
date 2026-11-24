// Streaming report packaging runs through the injected project process capability.
export const reportTransferScript = String.raw`import gzip,hashlib,io,json,os,stat,sys,tarfile
from pathlib import Path
config=json.loads(sys.argv[1])
source=Path(config['source']);target=Path(config['target'])
class ReportTypeError(RuntimeError):
 def __init__(self,path):
  super().__init__('SOFTWARE_REPORT_TYPE_UNSUPPORTED')
  self.path=str(path.relative_to(source));self.kind='symlink' if path.is_symlink() else 'special-file'
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
def candidates():
 root=source/'_nestos/kanban'
 for part in (source/'_nestos',root,root/'artifacts'):
  if part.is_symlink():raise ReportTypeError(part)
 artifacts=root/'artifacts'
 if artifacts.exists():
  for directory,dirs,files in os.walk(artifacts,followlinks=False):
   dirs[:]=sorted(d for d in dirs if d not in ('node_modules','dist','build','dist-server','dist-ui','.cache','cache','profile','profiles','state') and not (Path(directory)/d).is_symlink())
   yield from (Path(directory)/f for f in sorted(files))
 if root.exists():yield from (p for p in root.iterdir() if p.is_file() and any(word in p.name.lower() for word in ('report','handoff')))
def regular_size(path):
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode):raise ReportTypeError(path)
 return info.st_size
def usage():
 groups={};files=0;total=0;root=source/'_nestos/kanban'
 for path in candidates():
  size=regular_size(path);parts=path.relative_to(root).parts
  directory='/'.join(parts[:2]) if len(parts)>2 else ('artifacts' if len(parts)==2 else '.')
  if directory not in groups and len(groups)>=2000:directory='…'
  group=groups.setdefault(directory,{'path':directory,'files':0,'bytes':0})
  group['files']+=1;group['bytes']+=size;files+=1;total+=size
 return {'files':files,'bytes':total,'maxFiles':config['maxFiles'],'maxBytes':config['maxBytes'],
  'directories':sorted(groups.values(),key=lambda group:(-group['bytes'],group['path']))[:8]}
def reports():
 rows=[];total=0
 for path in sorted(candidates()):
  size=regular_size(path)
  total+=size
  if len(rows)>=config['maxFiles'] or total>config['maxBytes']:raise RuntimeError('SOFTWARE_REPORT_BUDGET_EXCEEDED')
  rows.append({'path':str(path.relative_to(source)),'bytes':size,'sha256':digest(path)})
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
def release():
 fingerprint=config['fingerprint'];path=target/(fingerprint+'.tar.gz');receipt=target/(fingerprint+'.json')
 if any(part.is_symlink() for part in (target,*target.parents,receipt,path)):raise RuntimeError('SOFTWARE_REPORT_TARGET_INVALID')
 if not receipt.is_file():raise RuntimeError('SOFTWARE_REPORT_HANDOFF_UNCONFIRMED')
 meta=json.loads(receipt.read_text())
 if any(meta.get(field)!=config[field] for field in ('fingerprint','sha256','resourceId','owner')):raise RuntimeError('SOFTWARE_REPORT_PACKAGE_INVALID')
 if path.exists():
  verify(path,meta);path.unlink()
 descriptor=os.open(target,os.O_RDONLY)
 try:os.fsync(descriptor)
 finally:os.close(descriptor)
 return {'fingerprint':fingerprint}
def main():
 if config['mode']=='release':return release()
 if config['mode']=='usage':return usage()
 rows=reports();fingerprint=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 path=target/(fingerprint+'.tar.gz');receipt=target/(fingerprint+'.json')
 if receipt.exists():
  meta=json.loads(receipt.read_text())
  if meta.get('fingerprint')!=fingerprint or meta.get('files')!=rows or meta.get('resourceId')!=config['resourceId'] or meta.get('owner')!=config['owner']:raise RuntimeError('SOFTWARE_REPORT_PACKAGE_INVALID')
  verify(path,meta);return meta
 if config['mode']=='inspect':return {'fingerprint':fingerprint,'fileCount':len(rows),'bytes':sum(r['bytes'] for r in rows),'existing':False}
 if config['mode'] in ('verify','reconcile'):raise RuntimeError('SOFTWARE_REPORT_HANDOFF_UNCONFIRMED')
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
 value=main()
 if value.get('sha256'):
  count=len(value['files'])
  value={key:value[key] for key in ('fingerprint','resourceId','owner','bytes','sha256')}
  value['fileCount']=count
  if config['mode'] in ('inspect','reconcile'):value['existing']=True
 print(json.dumps(value))
except Exception as error:
 code=str(error) if str(error).startswith('SOFTWARE_REPORT_') else 'SOFTWARE_REPORT_TRANSFER_FAILED'
 print(json.dumps({'code':code,'class':type(error).__name__,**({'path':error.path,'kind':error.kind} if isinstance(error,ReportTypeError) else {})}));sys.exit(1)
`;
