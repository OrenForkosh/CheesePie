function out = load_tracking_obj(path)
out = struct('ok', false, 'x', [], 'y', [], 'colors', []);
try
    data = load(path);
catch
    return;
end
fields = fieldnames(data);
if isempty(fields)
    return;
end
obj = data.(fields{1});
obj = unwrap_self(obj);
track = get_field(obj, {'tracking', 'Tracking'});
if isempty(track)
    return;
end
x = get_field(track, {'x', 'X'});
y = get_field(track, {'y', 'Y', 't'});
if isempty(x) || isempty(y)
    return;
end
out.x = x;
out.y = y;
out.colors = get_colors(obj);
out.ok = true;
end

function obj = unwrap_self(obj)
try
    if isobject(obj) && isprop(obj, 'self')
        obj = obj.self;
        return;
    end
catch
end
if isstruct(obj) && isfield(obj, 'self')
    obj = obj.self;
end
end

function val = get_field(obj, names)
val = [];
for i = 1:numel(names)
    name = names{i};
    if isstruct(obj) && isfield(obj, name)
        val = obj.(name);
        return;
    end
    try
        if isobject(obj) && isprop(obj, name)
            val = obj.(name);
            return;
        end
    catch
    end
end
end

function colors = get_colors(obj)
colors = [];
color_obj = get_field(obj, {'colors', 'Colors'});
if ~isempty(color_obj)
    if isstruct(color_obj) && isfield(color_obj, 'mice')
        colors = color_obj.mice;
        return;
    end
    try
        if isobject(color_obj) && isprop(color_obj, 'mice')
            colors = color_obj.mice;
            return;
        end
    catch
    end
    colors = color_obj;
    return;
end
meta = get_field(obj, {'Meta', 'meta'});
if ~isempty(meta)
    colors = get_field(meta, {'Colors', 'colors'});
end
end
