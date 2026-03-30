
import boto3 
import math
from config import Config 
from models import StartUploadResponse

class UploadVideo:
    
    s3 = None 
    
    def __init__(self):
        
        self.s3 = boto3.client(
            's3',
            aws_access_key_id=Config.S3_KEY,
            aws_secret_access_key=Config.S3_SECRET,
            region_name=Config.S3_REGION,
            endpoint_url=Config.S3_ENDPOINT
        )
        
        self.s3_browser = boto3.client(
            's3',
            aws_access_key_id=Config.S3_KEY,
            aws_secret_access_key=Config.S3_SECRET,
            region_name=Config.S3_REGION,
            endpoint_url=Config.S3_PUBLIC_URL
        )
        
    def get_presigned_urls(self, key:str, content_type:str, file_size: int, expires=3600, chunk_size = 10 * 1024**2) -> StartUploadResponse:
        chunks = math.ceil(file_size / chunk_size)
        load = {
            "ACL": "public-read",
            "Bucket": Config.BUCKET_NAME,
            "Key": key,
            "ContentType": content_type,
        }
        data = self.s3.create_multipart_upload(**load)
        
        upload_id = data['UploadId']
        
        urls = []
        
        for i in range(1, chunks+1):
            signed_url = self.s3_browser.generate_presigned_url(
                ClientMethod="upload_part",
                Params = {
                    "Bucket": Config.BUCKET_NAME,
                    "Key": key,
                    "PartNumber": i,
                    "UploadId": upload_id
                },
                ExpiresIn = expires,
            )
            urls.append(self._fix_url(signed_url))
        
        return StartUploadResponse(
            urls= urls,
            chunk_size= chunks,
            key= key,
            upload_id=upload_id,
            fields={
                "Content-Type": content_type,
                "Key": key,
            }
        )
    
    def complete_multipart_upload(self, key:str, upload_id:str, etags_string:str):
        etags = etags_string.split(',')
        
        parts = [{"ETag": etags[i], "PartNumber": i + 1} for i in range(len(etags))]
        
        response = self.s3.complete_multipart_upload(
            Bucket=Config.BUCKET_NAME,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts}
        )
        
        return response

    def download_file(self, bucket_name: str, key: str, destination_path: str):
        # Downloads to local scratch space
        self.s3.download_file(
            Bucket=bucket_name,
            Key=key,
            Filename=destination_path
        )
    
    def _fix_url(self, url: str) -> str:
        if Config.S3_ENDPOINT != Config.S3_PUBLIC_URL:
            return url.replace(Config.S3_ENDPOINT, Config.S3_PUBLIC_URL)
        return url
