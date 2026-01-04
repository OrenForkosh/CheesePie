function mask01 = segment_frame(img_or_path)
%SEGMENT_FRAME Read an image and return a binary segment via imsegfmm.
%   mask01 = SEGMENT_FRAME(img_or_path)
%   img_or_path: string with a file path or an image matrix.
%   mask01: uint8 matrix same size as input, values 0 or 1.

% Read image
if ischar(img_or_path) || isstring(img_or_path)
    I = imread(img_or_path);
else
    I = img_or_path;
end

% Ensure grayscale
% Convert to grayscale single in [0,1]
if ndims(I) == 3
    try
        G = im2single(rgb2gray(I));
    catch
        G = im2single(rgb2gray(im2uint8(I)));
    end
else
    G = im2single(I);
end
G = mat2gray(G); % ensure [0,1]

% Initial coarse foreground estimation (Otsu or adaptive)
try
    level = graythresh(G);
    BW0 = imbinarize(G, level);
catch
    T = adaptthresh(im2uint8(G), 0.5);
    BW0 = imbinarize(im2uint8(G), T);
end

% Morphological cleanup and sure-foreground seeds
BWc = imopen(BW0, strel('disk', 2));
BWc = imclearborder(BWc);
BWc = bwareaopen(BWc, 50);
Seeds = imerode(BWc, strel('disk', 2));

% Fallback: if no seeds, pick the brightest pixel as seed
if ~any(Seeds(:))
    [~, idx] = max(G(:));
    Seeds(idx) = true;
end

% Subsample seeds if too many (Performance guard)
[sr, sc] = find(Seeds);
maxSeeds = 2000;
if numel(sr) > maxSeeds
    step = ceil(numel(sr) / maxSeeds);
    sr = sr(1:step:end);
    sc = sc(1:step:end);
end

% Compute gray-level difference weights and segment with FMM
try
    W = graydiffweight(G, sc, sr);
catch
    % Older MATLAB may require double input
    W = graydiffweight(im2double(G), sc, sr);
end
thresh = 0.25; % default threshold; smaller -> tighter region
try
    BW = imsegfmm(W, sc, sr, thresh);
catch
    % Attempt with double W for compatibility
    BW = imsegfmm(im2double(W), sc, sr, thresh);
end

% Ensure mask is logical and same size as input
BW = logical(BW);
% Return as uint8 0/1 to be explicit
mask01 = uint8(BW);

end
