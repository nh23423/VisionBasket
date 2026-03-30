import torchreid
import torch
import cv2
import numpy as np

class ReIDPredictor:
    def __init__(self, device='cuda', model_name='osnet_x0_25'):
        self.device = torch.device(device if torch.cuda.is_available() else 'cpu')
        self.extractor = torchreid.utils.FeatureExtractor(
            model_name=model_name,
            model_path=None,          # auto-download pretrained weights
            device=str(self.device)
        )

    def get_signature(self, crop):
        """Extract L2-normalised 512-D embedding from a BGR crop."""
        # Convert BGR (OpenCV) to RGB (OSNet expects RGB)
        crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        
        # FeatureExtractor handles resize + normalisation internally
        features = self.extractor(crop_rgb)          # shape: (1, 512)
        features = torch.nn.functional.normalize(features, p=2, dim=1)
        return features.squeeze()                    # shape: (512,)

    @staticmethod
    def similarity_check(sig1, sig2, threshold=0.7):
        """Return (is_match, cosine_similarity)."""
        sim = torch.nn.functional.cosine_similarity(
            sig1.unsqueeze(0),
            sig2.unsqueeze(0)
        ).item()
        return sim > threshold, sim