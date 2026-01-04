function idx = Segment(img_or_path, bg_or_path)
%SEGMENT Color-based clustering for mice using background frame.
%   idx = SEGMENT(img_or_path, bg_or_path)
%   - img_or_path: path to current image file or image matrix
%   - bg_or_path: path to background image file or image matrix
%   - idx: uint8 matrix, same HxW as input, with values:
%       0 = no cluster/background
%       1 = Red, 2 = Green, 3 = Blue, 4 = Yellow

% Read image
if ischar(img_or_path) || isstring(img_or_path)
    I = imread(img_or_path);
else
    I = img_or_path;
end
if ischar(bg_or_path) || isstring(bg_or_path)
    B = imread(bg_or_path);
else
    B = bg_or_path;
end

% Ensure RGB double in [0,1]
if size(I,3) == 1, I = repmat(I, 1, 1, 3); end
if size(B,3) == 1, B = repmat(B, 1, 1, 3); end
if ~isfloat(I), I = im2double(I); else, I = max(0, min(1, I)); end
if ~isfloat(B), B = im2double(B); else, B = max(0, min(1, B)); end

% Resize background if needed
if any(size(B,1,2) ~= size(I,1,2))
    try
        B = imresize(B, [size(I,1), size(I,2)]);
    catch
        B = imresize(im2double(B), [size(I,1), size(I,2)]);
    end
end

% Precompute HSV for background gating
HSV = rgb2hsv(I);
H = HSV(:,:,1); S = HSV(:,:,2); V = HSV(:,:,3);

% Candidate colored pixels: sufficient saturation and brightness
satMin = 0.25;  % adjust as needed
valMin = 0.15;  % adjust as needed
candHSV = (S >= satMin) & (V >= valMin);

% Background difference mask (motion/foreground)
diffImg = sqrt(sum((I - B).^2, 3)); % Euclidean distance in RGB
% Adaptive threshold via Otsu on diff if possible, else fixed
try
    level = graythresh(mat2gray(diffImg));
    candFG = imbinarize(mat2gray(diffImg), level);
catch
    candFG = diffImg > 0.1; % fixed fallback
end
% Combine constraints
cand = candHSV & candFG;

% Target colors (RGBY)
targets = [1 0 0; 0 1 0; 0 0 1; 1 1 0]; % R,G,B,Y
% Normalize yellow to unit-ish magnitude to balance distances
targets(4,:) = targets(4,:) ./ max(1, norm(targets(4,:))); %#ok<NORMOK>

R = I(:,:,1); G = I(:,:,2); B = I(:,:,3);
[Hgt, Wdt, ~] = size(I);
idx = zeros(Hgt, Wdt, 'uint8');

% Compute squared distances to each target
D = zeros(Hgt, Wdt, 4, 'single');
D(:,:,1) = (R - targets(1,1)).^2 + (G - targets(1,2)).^2 + (B - targets(1,3)).^2; % Red
D(:,:,2) = (R - targets(2,1)).^2 + (G - targets(2,2)).^2 + (B - targets(2,3)).^2; % Green
D(:,:,3) = (R - targets(3,1)).^2 + (G - targets(3,2)).^2 + (B - targets(3,3)).^2; % Blue
D(:,:,4) = (R - targets(4,1)).^2 + (G - targets(4,2)).^2 + (B - targets(4,3)).^2; % Yellow

% Assign to nearest target where candidate; else 0
[~, K] = min(D, [], 3);
K(~cand) = 0;
idx = uint8(K);

% Optional cleanup per cluster
se = strel('disk', 2);
for k = 1:4
    M = (idx == k);
    if any(M(:))
        M = imopen(M, se);
        M = imclose(M, se);
        M = bwareaopen(M, 50);
        idx(M) = k;
        idx(~M & idx == k) = 0;
    end
end

end
