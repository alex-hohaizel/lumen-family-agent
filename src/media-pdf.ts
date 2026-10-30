import {PDFDocument,PDFArray,PDFDict,PDFName,PDFRawStream,PDFString,PDFHexString,decodePDFRawStream} from 'pdf-lib';
import {createHash} from 'node:crypto';

export interface AlbumPdfContents {pages:number;attachments:{name:string;sha256:string;bytes:number}[];}
/** Decode the exported PDF and embedded originals; no filename/MIME assertion substitutes for readback. */
export async function inspectAlbumPdf(bytes:Uint8Array):Promise<AlbumPdfContents>{
 const pdf=await PDFDocument.load(bytes),attachments:AlbumPdfContents['attachments']=[],names=pdf.catalog.lookupMaybe(PDFName.of('Names'),PDFDict),embedded=names?.lookupMaybe(PDFName.of('EmbeddedFiles'),PDFDict);
 const visit=(tree:PDFDict)=>{
  const entries=tree.lookupMaybe(PDFName.of('Names'),PDFArray);if(entries)for(let i=0;i<entries.size();i+=2){const label=entries.lookup(i),spec=entries.lookup(i+1,PDFDict),ef=spec.lookup(PDFName.of('EF'),PDFDict),stream=ef.lookup(PDFName.of('F'));if(!(stream instanceof PDFRawStream))throw Error('album_attachment_stream_invalid');const decoded=decodePDFRawStream(stream).decode();if(!(label instanceof PDFString||label instanceof PDFHexString))throw Error('album_attachment_name_invalid');attachments.push({name:label.decodeText(),sha256:createHash('sha256').update(decoded).digest('hex'),bytes:decoded.length});}
  const children=tree.lookupMaybe(PDFName.of('Kids'),PDFArray);if(children)for(let i=0;i<children.size();i++)visit(children.lookup(i,PDFDict));
 };
 if(embedded)visit(embedded);return {pages:pdf.getPageCount(),attachments};
}
